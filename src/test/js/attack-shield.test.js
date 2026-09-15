const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadGameClasses() {
  const htmlPath = path.resolve(__dirname, "../../../instructor.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
  const appScript = scripts.map((match) => match[1]).find((script) => script.includes("class GameController"));
  assert.ok(appScript, "Instructor application script was not found");

  const testableScript = appScript.replace(
    /\s*const app = new InstructorApp\(\);\s*app\.init\(\);\s*\}\)\(\);\s*$/,
    "\n      globalThis.__gameTestExports = { GameController, InstructorApp, PHASES };\n    })();"
  );
  assert.notEqual(testableScript, appScript, "Instructor bootstrap was not replaced");

  const storage = new Map();
  const context = {
    clearInterval,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    Date,
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, String(value))
    },
    Math,
    setInterval,
    setTimeout,
    URL,
    URLSearchParams,
    window: {}
  };
  context.globalThis = context;
  vm.runInNewContext(testableScript, context, { filename: "instructor.html" });
  return context.__gameTestExports;
}

const { GameController, InstructorApp, PHASES } = loadGameClasses();

function makePlayer(id, score = 5000) {
  return {
    id,
    name: id.toUpperCase(),
    score,
    joinedAt: 1,
    lastSeenAt: 1,
    removed: false
  };
}

function makeController(players) {
  const controller = new GameController(null);
  const question = {
    query: "Test question",
    pointValue: 100,
    options: [{ id: "a", letter: "A", text: "Answer", color: "blue", correct: true }]
  };
  controller.activeGame = {
    gameId: "TEST",
    quizTitle: "Attack tests",
    phase: PHASES.ANSWER_REVEAL,
    questionIndex: 0,
    questionStartedAt: 0,
    questionEndsAt: 0,
    questions: [question, question, question],
    players,
    submissions: {},
    currentQuestionPowerSummary: null,
    revealedAnswer: null
  };
  controller.ensureMaps();
  return controller;
}

test("a strike changes only its selected target and increments that target's attack count", () => {
  const attacker = makePlayer("attacker");
  const target = makePlayer("target");
  const bystander = makePlayer("bystander");
  attacker.streakPrizeAvailable = true;
  const controller = makeController({ attacker, target, bystander });

  const claim = controller.claimStreakPrize("attacker", "STEAL_1000", "target");
  assert.equal(claim.ok, true);
  assert.equal(target.attackedCount, 1);
  assert.equal(bystander.attackedCount, 0);

  controller.startQuestion();
  assert.equal(attacker.score, 5000);
  assert.equal(target.score, 4000);
  assert.equal(bystander.score, 5000);
  assert.equal(target.strikeCount, 1);
});

test("one normal shield blocks every valid strike in its protected question", () => {
  const first = makePlayer("first");
  const second = makePlayer("second");
  const target = makePlayer("target");
  target.pointShieldNext = true;
  target.pointShieldMode = "NORMAL";
  target.pendingIncomingStrikes = ["first", "second", "first"];
  target.incomingStrikeCount = 3;
  target.attackedCount = 3;
  const controller = makeController({ first, second, target });

  controller.startQuestion();
  assert.equal(target.score, 5000);
  assert.equal(target.strikeOutcome, "SHIELD_BLOCK");
  assert.equal(target.strikeCount, 3);
  assert.equal(target.incomingStrikeCount, 0);
});

test("reflective shield returns each strike to its originating attacker", () => {
  const first = makePlayer("first");
  const second = makePlayer("second");
  const target = makePlayer("target");
  first.pointShieldNext = true;
  first.pointShieldMode = "NORMAL";
  target.pointShieldNext = true;
  target.pointShieldMode = "REFLECTIVE";
  target.pendingIncomingStrikes = ["first", "second", "first"];
  target.incomingStrikeCount = 3;
  const controller = makeController({ first, second, target });

  controller.startQuestion();
  assert.equal(target.score, 5000);
  assert.equal(target.strikeOutcome, "REFLECTED_BLOCK");
  assert.equal(target.strikeCount, 3);
  assert.equal(first.score, 3000);
  assert.equal(second.score, 4000);
});

test("removed and missing attackers cannot cause ghost deductions", () => {
  const removed = makePlayer("removed");
  removed.removed = true;
  const target = makePlayer("target");
  target.pendingIncomingStrikes = ["removed", "missing"];
  target.incomingStrikeCount = 2;
  const controller = makeController({ removed, target });

  controller.startQuestion();
  assert.equal(target.score, 5000);
  assert.equal(target.strikeCount, 0);
  assert.equal(target.strikeOutcome, "");
  assert.equal(target.incomingStrikeCount, 0);
});

test("active shield expires when its protected question ends", () => {
  const target = makePlayer("target");
  target.pointShieldNext = true;
  target.pointShieldMode = "NORMAL";
  const controller = makeController({ target });

  controller.startQuestion();
  assert.equal(target.pointShieldQuestionIndex, 1);
  assert.equal(target.pointShieldActiveMode, "NORMAL");

  controller.endQuestion();
  assert.equal(target.pointShieldQuestionIndex, null);
  assert.equal(target.pointShieldActiveMode, "NONE");
});

test("null shield index never blocks first-question strikes", () => {
  const attacker = makePlayer("attacker");
  const target = makePlayer("target");
  attacker.streakPrizeAvailable = true;
  target.pointShieldQuestionIndex = null;
  target.pointShieldActiveMode = "REFLECTIVE";
  const controller = makeController({ attacker, target });

  const claim = controller.claimStreakPrize("attacker", "STEAL_1000", "target");
  assert.equal(claim.ok, true);

  controller.startQuestion();
  assert.equal(target.strikeOutcome, "STRUCK");
  assert.equal(target.score, 4000);
  assert.equal(attacker.score, 5000);
  assert.equal(controller.activeGame.currentQuestionPowerSummary.shieldCount, 0);
  assert.equal(controller.activeGame.currentQuestionPowerSummary.reflectiveShieldCount, 0);
});

test("player-scoped messages reject a payload identity mismatch", () => {
  const resolve = InstructorApp.prototype.getTrustedPlayerMessage;
  const trusted = resolve.call({}, { senderId: "alice", payload: { playerId: "alice", mode: "NORMAL" } });
  const rejected = resolve.call({}, { senderId: "alice", payload: { playerId: "bob", mode: "NORMAL" } });

  assert.equal(trusted.payload.playerId, "alice");
  assert.equal(rejected, null);
});

test("an attack cannot be queued when no next question remains", () => {
  const attacker = makePlayer("attacker");
  const target = makePlayer("target");
  attacker.streakPrizeAvailable = true;
  const controller = makeController({ attacker, target });
  controller.activeGame.questionIndex = controller.activeGame.questions.length - 1;

  const claim = controller.claimStreakPrize("attacker", "STEAL_1000", "target");
  assert.equal(claim.ok, false);
  assert.equal(target.pendingIncomingStrikes.length, 0);
  assert.equal(target.attackedCount, 0);
});

test("a wrong double-down answer loses exactly the question value", () => {
  const player = makePlayer("player", 5000);
  player.doubleDownNext = true;
  const controller = makeController({ player });
  controller.activeGame.phase = PHASES.QUESTION;
  controller.activeGame.submissions = {
    "0": {
      player: {
        playerId: "player",
        questionIndex: 0,
        selectedOptionIds: ["wrong"],
        submittedAt: 10
      }
    }
  };
  controller.activeGame.questions[0] = {
    query: "Test question",
    pointValue: 100,
    options: [
      { id: "correct", letter: "A", text: "Correct", color: "blue", correct: true },
      { id: "wrong", letter: "B", text: "Wrong", color: "red", correct: false }
    ]
  };

  const reveal = controller.endQuestion();
  assert.ok(reveal);
  assert.equal(player.score, 4900);
  assert.equal(reveal.playerOutcomes.player.earnedPoints, -100);
  assert.equal(player.history.at(-1).kind, "QUESTION_RESULT");
  assert.equal(player.history.at(-1).pointsDelta, -100);
  assert.equal(player.history.at(-1).scoreBefore, 5000);
  assert.equal(player.history.at(-1).scoreAfter, 4900);
});

test("score reset is documented and the complete ledger is sent with leaderboard rows", () => {
  const player = makePlayer("player", 0);
  const controller = makeController({ player });

  for (let index = 1; index <= 65; index += 1) {
    player.score += 1;
    controller.recordPlayerHistory("player", {
      kind: "TEST_AWARD",
      category: "answer",
      title: "Test award",
      pointsDelta: 1,
      scoreBefore: player.score - 1,
      scoreAfter: player.score
    });
  }

  assert.equal(controller.resetScore("player"), true);
  const history = controller.getPlayerHistory("player");
  const reset = history.at(-1);
  const leaderboardPlayer = controller.getLeaderboard().find((row) => row.playerId === "player");

  assert.equal(player.score, 0);
  assert.equal(history.length, 66);
  assert.equal(reset.kind, "SCORE_RESET");
  assert.equal(reset.pointsDelta, -65);
  assert.equal(reset.scoreBefore, 65);
  assert.equal(reset.scoreAfter, 0);
  assert.equal(leaderboardPlayer.history.length, history.length);
  assert.equal(history.reduce((total, entry) => total + entry.pointsDelta, 0), player.score);
});

test("same submissionId retries are accepted idempotently", () => {
  const player = makePlayer("player", 5000);
  const controller = makeController({ player });
  controller.activeGame.phase = PHASES.QUESTION;
  controller.activeGame.questionIndex = 0;
  controller.activeGame.questionStartedAt = Date.now() - 2000;
  controller.activeGame.questionEndsAt = Date.now() + 20000;

  const msg = {
    messageId: "msg-1",
    payload: {
      playerId: "player",
      questionIndex: 0,
      submissionId: "sub-123",
      selectedOptionIds: ["a"],
      submittedAt: Date.now()
    }
  };

  const first = controller.acceptSubmission(msg);
  const replay = controller.acceptSubmission(msg);

  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.submission.submissionId, "sub-123");
});

test("accepted submission retry replays after the question closes", () => {
  const player = makePlayer("player", 5000);
  const controller = makeController({ player });
  controller.activeGame.phase = PHASES.QUESTION;
  controller.activeGame.questionIndex = 0;
  controller.activeGame.questionStartedAt = Date.now() - 2000;
  controller.activeGame.questionEndsAt = Date.now() + 20000;

  const msg = {
    messageId: "msg-closed-retry",
    payload: {
      playerId: "player",
      questionIndex: 0,
      submissionId: "sub-closed-retry",
      selectedOptionIds: ["a"],
      submittedAt: Date.now()
    }
  };

  const accepted = controller.acceptSubmission(msg);
  assert.equal(accepted.ok, true);
  assert.ok(accepted.acceptedAt > 0);
  controller.activeGame.phase = PHASES.ANSWER_REVEAL;
  const replay = controller.acceptSubmission(msg);

  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.acceptedAt, accepted.acceptedAt);
  assert.equal(replay.submission.submissionId, "sub-closed-retry");
});

test("reliable power action retries do not repeat point mutations", () => {
  const player = makePlayer("player", 5000);
  const leader = makePlayer("leader", 6000);
  player.doubleDownUses = 3;
  const others = {};
  for (let index = 0; index < 8; index += 1) {
    others["other-" + index] = makePlayer("other-" + index, 4000 - index);
  }
  const controller = makeController(Object.assign({ player, leader }, others));
  const msg = {
    type: "DOUBLE_DOWN_BUY",
    messageId: "envelope-1",
    payload: { playerId: "player", actionId: "action-buy-1" }
  };

  const first = controller.runReliableAction(msg, () => controller.purchaseDoubleDown("player"));
  msg.messageId = "envelope-2";
  const replay = controller.runReliableAction(msg, () => controller.purchaseDoubleDown("player"));

  assert.equal(first.result.ok, true);
  assert.equal(first.replay, false);
  assert.equal(replay.result.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(player.score, 2000);
  assert.equal(player.doubleDownPurchasedCredits, 1);
  assert.equal(player.history.filter((entry) => entry.kind === "DOUBLE_DOWN_PURCHASED").length, 1);
});

test("reliable action failures are replayed without rerunning the operation", () => {
  const player = makePlayer("player", 0);
  const controller = makeController({ player });
  const msg = {
    type: "POINT_SHIELD_BUY",
    messageId: "envelope-failure-1",
    payload: { playerId: "player", actionId: "action-failure-1", mode: "NORMAL" }
  };
  let calls = 0;
  const perform = () => {
    calls += 1;
    return controller.purchasePointShield("player", "NORMAL");
  };

  const first = controller.runReliableAction(msg, perform);
  msg.messageId = "envelope-failure-2";
  const replay = controller.runReliableAction(msg, perform);

  assert.equal(first.result.ok, false);
  assert.equal(replay.result.ok, false);
  assert.equal(replay.replay, true);
  assert.equal(calls, 1);
});

test("different submissionId after accepted answer is rejected as duplicate", () => {
  const player = makePlayer("player", 5000);
  const controller = makeController({ player });
  controller.activeGame.phase = PHASES.QUESTION;
  controller.activeGame.questionIndex = 0;
  controller.activeGame.questionStartedAt = Date.now() - 2000;
  controller.activeGame.questionEndsAt = Date.now() + 20000;

  const accepted = controller.acceptSubmission({
    messageId: "msg-1",
    payload: {
      playerId: "player",
      questionIndex: 0,
      submissionId: "sub-123",
      selectedOptionIds: ["a"],
      submittedAt: Date.now()
    }
  });
  const duplicate = controller.acceptSubmission({
    messageId: "msg-2",
    payload: {
      playerId: "player",
      questionIndex: 0,
      submissionId: "sub-456",
      selectedOptionIds: ["a"],
      submittedAt: Date.now()
    }
  });

  assert.equal(accepted.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "Duplicate submission");
  assert.equal(duplicate.acceptedSubmissionId, "sub-123");
});