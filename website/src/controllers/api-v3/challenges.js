import { authWithHeaders } from '../../middlewares/api-v3/auth';
import cron from '../../middlewares/api-v3/cron';
import { model as Challenge } from '../../models/challenge';
import { model as Group } from '../../models/group';
import { model as User } from '../../models/user';
import {
  NotFound,
  NotAuthorized,
} from '../../libs/api-v3/errors';
import shared from '../../../../common';
import * as Tasks from '../../models/task';
import { txnEmail } from '../../libs/api-v3/email';
import pushNotify from '../../libs/api-v3/pushNotifications';
import Q from 'q';

let api = {};

/**
 * @api {post} /challenges Create a new challenge
 * @apiVersion 3.0.0
 * @apiName CreateChallenge
 * @apiGroup Challenge
 *
 * @apiSuccess {object} challenge The newly created challenge
 */
api.createChallenge = {
  method: 'POST',
  url: '/challenges',
  middlewares: [authWithHeaders(), cron],
  handler (req, res, next) {
    let user = res.locals.user;

    req.checkBody('group', res.t('groupIdRequired')).notEmpty();

    let validationErrors = req.validationErrors();
    if (validationErrors) return next(validationErrors);

    let groupId = req.body.group;
    let prize = req.body.prize;

    Group.getGroup(user, groupId, '-chat')
    .then(group => {
      if (!group) throw new NotFound(res.t('groupNotFound'));

      if (group.leaderOnly && group.leaderOnly.challenges && group.leader !== user._id) {
        throw new NotAuthorized(res.t('onlyGroupLeaderChal'));
      }

      if (groupId === 'habitrpg' && prize < 1) {
        throw new NotAuthorized(res.t('pubChalsMinPrize'));
      }

      if (prize > 0) {
        let groupBalance = group.balance && group.leader === user._id ? group.balance : 0;
        let prizeCost = prize / 4;

        if (prizeCost > user.balance + groupBalance) {
          throw new NotAuthorized(res.t('cantAfford'));
        }

        if (groupBalance >= prizeCost) {
          // Group pays for all of prize
          group.balance -= prizeCost;
        } else if (groupBalance > 0) {
          // User pays remainder of prize cost after group
          let remainder = prizeCost - group.balance;
          group.balance = 0;
          user.balance -= remainder;
        } else {
          // User pays for all of prize
          user.balance -= prizeCost;
        }
      }

      group.challengeCount += 1;

      let tasks = req.body.tasks || []; // TODO validate
      req.body.leader = user._id;
      req.body.official = user.contributor.admin && req.body.official;
      let challenge = new Challenge(Challenge.sanitize(req.body));

      let toSave = tasks.map(tasks, taskToCreate => {
        // TODO validate type
        let task = new Tasks[taskToCreate.type](Tasks.Task.sanitizeCreate(taskToCreate));
        task.challenge.id = challenge._id;
        challenge.tasksOrder[`${task.type}s`].push(task._id);
        return task.save();
      });

      toSave.unshift(challenge, group);
      return Q.all(toSave);
    })
    .then(results => {
      let savedChal = results[0];
      return savedChal.syncToUser(user) // (it also saves the user)
        .then(() => res.respond(201, savedChal));
    })
    .catch(next);
  },
};

/**
 * @api {get} /challenges Get challenges for a user
 * @apiVersion 3.0.0
 * @apiName GetChallenges
 * @apiGroup Challenge
 *
 * @apiSuccess {Array} challenges An array of challenges
 */
api.getChallenges = {
  method: 'GET',
  url: '/challenges',
  middlewares: [authWithHeaders(), cron],
  handler (req, res, next) {
    let user = res.locals.user;

    let groups = user.guilds || [];
    if (user.party._id) groups.push(user.party._id);
    groups.push('habitrpg'); // Public challenges

    Challenge.find({
      $or: [
        {_id: {$in: user.challenges}}, // Challenges where the user is participating
        {group: {$in: groups}}, // Challenges in groups where I'm a member
        {leader: user._id}, // Challenges where I'm the leader
      ],
      _id: {$ne: '95533e05-1ff9-4e46-970b-d77219f199e9'}, // remove the Spread the Word Challenge for now, will revisit when we fix the closing-challenge bug TODO revisit
    })
    .sort('-official -timestamp')
    // TODO populate
    // .populate('group', '_id name type')
    // .populate('leader', 'profile.name')
    .exec()
    .then(challenges => {
      res.respond(200, challenges);
    })
    .catch(next);
  },
};

// TODO everything here should be moved to a worker
// actually even for a worker it's probably just to big and will kill mongo
function _closeChal (challenge, broken = {}) {
  let winner = broken.winner;
  let brokenReason = broken.broken;

  let tasks = [
    // Delete the challenge
    Challenge.remove({_id: challenge._id}).exec(),
    // And it's tasks
    Tasks.Task.remove({'challenge.id': challenge._id, userId: {$exists: false}}).exec(),
    // Set the challenge tag to non-challenge status and remove the challenge from the user's challenges
    User.update({
      challenges: {$in: [challenge._id]},
      'tags._id': challenge._id,
    }, {
      $set: {'tags.$.challenge': false},
      $pull: {challenges: challenge._id},
    }, {multi: true}).exec(),
    // Break users' tasks
    Tasks.Task.update({
      'challenge.id': challenge._id,
    }, {
      $set: {
        'challenge.broken': brokenReason,
        'challenge.winner': winner && winner.profile.name,
      },
    }, {multi: true}).exec(),
    // Update the challengeCount on the group
    Group.update({_id: challenge.group}, {$inc: {challengeCount: -1}}).exec(),
  ];

  // Refund the leader if the challenge is closed and the group not the tavern
  if (challenge.group !== 'habitrpg' && brokenReason === 'CHALLENGE_DELETED') {
    tasks.push(User.update({_id: challenge.leader}, {$inc: {balance: challenge.prize / 4}}).exec());
  }

  // Award prize to winner and notify
  if (winner) {
    winner.achievements.challenges.push(challenge.name);
    winner.balance += challenge.prize / 4;
    tasks.push(winner.save().then(savedWinner => {
      if (savedWinner.preferences.emailNotifications.wonChallenge !== false) {
        txnEmail(savedWinner, 'won-challenge', [
          {name: 'CHALLENGE_NAME', content: challenge.name},
        ]);
      }

      pushNotify.sendNotify(savedWinner, shared.i18n.t('wonChallenge'), challenge.name); // TODO translate
    }));
  }

  return Q.allSettled(tasks); // TODO look if allSettle could be useful somewhere else
  // TODO catch and handle
}

/**
 * @api {delete} /challenges/:challengeId Delete a challenge
 * @apiVersion 3.0.0
 * @apiName DeleteChallenge
 * @apiGroup Challenge
 *
 * @apiSuccess {object} empty An empty object
 */
api.deleteChallenge = {
  method: 'DELETE',
  url: '/challenges/:challengeId',
  middlewares: [authWithHeaders(), cron],
  handler (req, res, next) {
    let user = res.locals.user;

    req.checkParams('challenge', res.t('challengeIdRequired')).notEmpty().isUUID();

    let validationErrors = req.validationErrors();
    if (validationErrors) return next(validationErrors);

    Challenge.findOne({_id: req.params.challengeId})
    .exec()
    .then(challenge => {
      if (!challenge) throw new NotFound(res.t('challengeNotFound'));
      if (challenge.leader !== user._id && !user.contributor.admin) throw new NotAuthorized(res.t('onlyLeaderDeleteChal'));

      res.respond(200, {});
      // Close channel in background
      _closeChal(challenge, {broken: 'CHALLENGE_DELETED'});
    })
    .catch(next);
  },
};

/**
 * @api {delete} /challenges/:challengeId Delete a challenge
 * @apiVersion 3.0.0
 * @apiName DeleteChallenge
 * @apiGroup Challenge
 *
 * @apiSuccess {object} empty An empty object
 */
api.selectChallengeWinner = {
  method: 'POST',
  url: '/challenges/:challengeId/selectWinner/:winnerId',
  middlewares: [authWithHeaders(), cron],
  handler (req, res, next) {
    let user = res.locals.user;
    let challenge;

    req.checkParams('challenge', res.t('challengeIdRequired')).notEmpty().isUUID();
    req.checkParams('winnerId', res.t('winnerIdRequired')).notEmpty().isUUID();

    let validationErrors = req.validationErrors();
    if (validationErrors) return next(validationErrors);

    Challenge.findOne({_id: req.params.challengeId})
    .exec()
    .then(challengeFound => {
      if (!challenge) throw new NotFound(res.t('challengeNotFound'));
      if (challenge.leader !== user._id && !user.contributor.admin) throw new NotAuthorized(res.t('onlyLeaderDeleteChal'));

      challenge = challengeFound;

      return User.findOne({_id: req.params.winnerId}).exec();
    })
    .then(winner => {
      if (!winner || winner.challenges.indexOf(challenge._id) === -1) throw new NotFound(res.t('winnerNotFound', {userId: req.parama.winnerId}));

      res.respond(200, {});
      // Close channel in background
      _closeChal(challenge, {broken: 'CHALLENGE_DELETED', winner});
    })
    .catch(next);
  },
};

export default api;
