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
});