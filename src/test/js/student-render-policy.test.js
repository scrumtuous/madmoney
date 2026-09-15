const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadStudentController() {
  const htmlPath = path.resolve(__dirname, "../../../index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi));
  const appScript = scripts.map((match) => match[1]).find((script) => script.includes("class StudentGameController"));
  assert.ok(appScript, "Student application script was not found");

  const testableScript = appScript.replace(
    /\s*const app = new StudentGameController\(\);\s*app\.init\(\);\s*\}\)\(\);\s*$/,
    "\n      globalThis.__studentTestExports = { StudentGameController, StudentUI, PHASES, MSG };\n    })();"
  );
  assert.notEqual(testableScript, appScript, "Student bootstrap was not replaced");

  const context = {
    console,
    Date,
    Math,
    URL,
    URLSearchParams,
    window: {},
    document: {
      elements: {},
      getElementById(id) {
        return this.elements[id] || null;
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(testableScript, context, { filename: "index.html" });
  context.__studentTestExports.testDocument = context.document;
  return context.__studentTestExports;
}

const { StudentGameController, StudentUI, PHASES, MSG, testDocument } = loadStudentController();

function makeController(phase = PHASES.ANSWER_REVEAL, questionIndex = 0) {
  const controller = Object.create(StudentGameController.prototype);
  controller.identity = { playerId: "local-player" };
  controller.streakTargetPickerPhase = null;
  controller.game = {
    phase,
    question: { questionIndex },
    reveal: phase === PHASES.ANSWER_REVEAL ? { questionIndex } : null,
    playerRemoved: false,
    fiftyFiftyQuestionIndex: null,
    fiftyFiftyRemovedOptionIds: []
  };
  return controller;
}

test("stealth target picker state survives same-phase updates and does not leak across phases", () => {
  const controller = makeController(PHASES.ANSWER_REVEAL, 0);

  controller.setStreakTargetPickerOpen(PHASES.ANSWER_REVEAL, true);
  assert.equal(controller.isStreakTargetPickerOpen(PHASES.ANSWER_REVEAL), true);
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.SCORE_UPDATED, beforeState(PHASES.ANSWER_REVEAL, 0, 0)),
    false
  );
  assert.equal(controller.isStreakTargetPickerOpen(PHASES.ANSWER_REVEAL), true);

  controller.game.phase = PHASES.LEADERBOARD;
  assert.equal(controller.isStreakTargetPickerOpen(PHASES.ANSWER_REVEAL), false);
  assert.equal(controller.isStreakTargetPickerOpen(PHASES.LEADERBOARD), false);

  controller.game.phase = PHASES.ANSWER_REVEAL;
  controller.setStreakTargetPickerOpen(PHASES.ANSWER_REVEAL, true);
  controller.refreshDoubleDownPolicy = () => {};
  controller.handleSnapshot({ type: MSG.STATE_SNAPSHOT, phase: PHASES.LEADERBOARD });
  controller.game.phase = PHASES.ANSWER_REVEAL;
  assert.equal(controller.isStreakTargetPickerOpen(PHASES.ANSWER_REVEAL), false);
});

test("stealth target menu opens names immediately and claims on one name click", () => {
  function makeEventTarget() {
    const listeners = {};
    return {
      listeners,
      addEventListener(type, listener) {
        listeners[type] = listener;
      }
    };
  }

  const button = {
    ...makeEventTarget(),
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };
  const targetButton = {
    focused: false,
    focus() {
      this.focused = true;
    },
    getAttribute(name) {
      return name === "data-target-id" ? "target-player" : null;
    },
    closest(selector) {
      return selector === ".power-target-option" ? this : null;
    }
  };
  const hiddenClasses = new Set(["d-none"]);
  const menu = {
    ...makeEventTarget(),
    classList: {
      add(name) {
        hiddenClasses.add(name);
      },
      remove(name) {
        hiddenClasses.delete(name);
      }
    },
    querySelectorAll(selector) {
      return selector === ".power-target-option" ? [targetButton] : [];
    }
  };
  const message = { textContent: "" };
  const documentListeners = {};
  const claims = [];
  const pickerStates = [];
  testDocument.elements = { stealthButton: button, stealthMenu: menu, stealthMessage: message };
  testDocument.addEventListener = (type, listener) => {
    documentListeners[type] = listener;
  };
  testDocument.removeEventListener = (type, listener) => {
    if (documentListeners[type] === listener) delete documentListeners[type];
  };

  try {
    StudentUI.prototype.bindStealthTargetMenu.call(StudentUI.prototype, "stealthButton", "stealthMenu", "stealthMessage", {
      onSetStreakTargetPickerOpen(open) {
        pickerStates.push(open);
      },
      onClaimStreakPrize(action, targetId) {
        claims.push({ action, targetId });
      }
    });

    button.listeners.click({ stopPropagation() {} });
    assert.equal(hiddenClasses.has("d-none"), false);
    assert.equal(button.attributes["aria-expanded"], "true");
    assert.equal(targetButton.focused, true);
    assert.equal(message.textContent, "Choose a player to launch the stealth attack.");

    menu.listeners.click({
      stopPropagation() {},
      target: targetButton
    });
    assert.equal(hiddenClasses.has("d-none"), true);
    assert.equal(button.attributes["aria-expanded"], "false");
    assert.deepEqual(pickerStates, [true, false]);
    assert.deepEqual(claims, [{ action: "STEAL_1000", targetId: "target-player" }]);
  } finally {
    testDocument.elements = {};
    delete testDocument.addEventListener;
    delete testDocument.removeEventListener;
  }
});

function beforeState(phase, questionIndex, revealKey = null) {
  return {
    phase,
    questionIndex,
    revealKey,
    playerRemoved: false
  };
}

test("power and score broadcasts never trigger full renders in a stable phase", () => {
  const controller = makeController();
  const before = beforeState(PHASES.ANSWER_REVEAL, 0, 0);
  const messageTypes = [
    MSG.DOUBLE_DOWN_SET,
    MSG.DOUBLE_DOWN_BUY_RESULT,
    MSG.POINT_SHIELD_BUY_RESULT,
    MSG.STREAK_PRIZE_RESULT,
    MSG.SCORE_UPDATED,
    MSG.SCORE_RESET
  ];

  messageTypes.forEach((messageType) => {
    assert.equal(controller.shouldRenderAfterMessage(messageType, before), false, messageType);
  });
});

test("question and reveal messages render only when their transition identity changes", () => {
  const controller = makeController(PHASES.QUESTION, 2);
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.QUESTION_STARTED, beforeState(PHASES.QUESTION, 2)),
    false
  );
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.QUESTION_STARTED, beforeState(PHASES.LEADERBOARD, 1)),
    true
  );

  controller.game.phase = PHASES.ANSWER_REVEAL;
  controller.game.reveal = { questionIndex: 2 };
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.ANSWER_REVEALED, beforeState(PHASES.ANSWER_REVEAL, 2, 2)),
    false
  );
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.ANSWER_REVEALED, beforeState(PHASES.QUESTION, 2, null)),
    true
  );
});

test("leaderboard and finished views render only on first phase entry", () => {
  const controller = makeController(PHASES.LEADERBOARD, 1);
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.LEADERBOARD, beforeState(PHASES.ANSWER_REVEAL, 1, 1)),
    true
  );
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.LEADERBOARD, beforeState(PHASES.LEADERBOARD, 1, 1)),
    false
  );

  controller.game.phase = PHASES.FINISHED;
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.GAME_FINISHED, beforeState(PHASES.LEADERBOARD, 1, 1)),
    true
  );
  assert.equal(
    controller.shouldRenderAfterMessage(MSG.GAME_FINISHED, beforeState(PHASES.FINISHED, 1, 1)),
    false
  );
});

test("leaderboard view does not render streak prize power controls", () => {
  const renderSource = StudentUI.prototype.renderLeaderboard.toString();

  assert.doesNotMatch(renderSource, /lbPowerBonusBtn/);
  assert.doesNotMatch(renderSource, /lbPowerCloakBtn/);
  assert.doesNotMatch(renderSource, /lbPowerStealthBtn/);
  assert.doesNotMatch(renderSource, /lbStreakPrizeTargetWrap/);
  assert.doesNotMatch(renderSource, /final-action-summary/);
});

test("targeted broadcasts are ignored by every non-target player", () => {
  const controller = makeController();
  const targetedTypes = [
    MSG.PLAYER_JOINED,
    MSG.ANSWER_SUBMITTED,
    MSG.FIFTY_FIFTY_RESULT,
    MSG.SCORE_RESET,
    MSG.PLAYER_REMOVED,
    MSG.DOUBLE_DOWN_SET,
    MSG.DOUBLE_DOWN_BUY_RESULT,
    MSG.POINT_SHIELD_BUY_RESULT,
    MSG.STREAK_PRIZE_RESULT
  ];

  targetedTypes.forEach((messageType) => {
    assert.equal(
      controller.isMessageRelevantToLocalPlayer({ type: messageType, payload: { playerId: "other-player" } }),
      false,
      messageType
    );
    assert.equal(
      controller.isMessageRelevantToLocalPlayer({ type: messageType, payload: { playerId: "local-player" } }),
      true,
      messageType
    );
  });

  assert.equal(
    controller.isMessageRelevantToLocalPlayer({
      type: MSG.STATE_SNAPSHOT,
      payload: { player: { id: "other-player" } }
    }),
    false
  );
  assert.equal(
    controller.isMessageRelevantToLocalPlayer({ type: MSG.SCORE_UPDATED, payload: {} }),
    true
  );
});

test("student shield helper treats null as inactive for the first question", () => {
  assert.equal(StudentUI.prototype.isShieldActiveForQuestion.call({}, null, 0), false);
  assert.equal(StudentUI.prototype.isShieldActiveForQuestion.call({}, 0, 0), true);
});

test("question power tile state reports attacker names and active double down", () => {
  const inactive = StudentUI.prototype.getQuestionPowerTileState.call({}, {
    strikeCount: 0,
    strikeAttackers: [],
    doubleDownActive: false
  });
  assert.equal(inactive.attackOn, false);
  assert.equal(inactive.attackTitle, "No incoming attack");
  assert.equal(inactive.doubleDownOn, false);

  const active = StudentUI.prototype.getQuestionPowerTileState.call({}, {
    strikeCount: 2,
    strikeAttackers: ["Alice", "Bob"],
    doubleDownActive: true
  });
  assert.equal(active.attackOn, true);
  assert.equal(active.attackTitle, "Under attack by: Alice, Bob");
  assert.equal(active.doubleDownOn, true);
  assert.equal(active.doubleDownTitle, "Double down is active for this question");
});

test("question lightweight updates refresh attack and double down tiles", () => {
  function makeElement() {
    const classes = new Set();
    return {
      title: "",
      textContent: "",
      attributes: {},
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        }
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      }
    };
  }

  const attackTile = makeElement();
  const doubleDownTile = makeElement();
  const strikeNotice = makeElement();
  const elements = {
    questionAttackTile: attackTile,
    questionDoubleDownTile: doubleDownTile,
    questionStrikeNotice: strikeNotice
  };
  testDocument.elements = elements;

  try {
    StudentUI.prototype.updateQuestionPowerTiles.call(StudentUI.prototype, {
      strikeCount: 2,
      strikeAttackers: ["Alice", "Bob"],
      strikeNotice: "Shadow Strike hit.",
      doubleDownActive: true
    });
  } finally {
    testDocument.elements = {};
  }

  assert.equal(attackTile.classList.contains("is-on"), true);
  assert.equal(attackTile.title, "Under attack by: Alice, Bob");
  assert.equal(attackTile.attributes["aria-label"], "Under attack by: Alice, Bob");
  assert.equal(doubleDownTile.classList.contains("is-on"), true);
  assert.equal(doubleDownTile.title, "Double down is active for this question");
  assert.equal(strikeNotice.textContent, "Shadow Strike hit.");
  assert.equal(strikeNotice.classList.contains("d-none"), false);
});

test("question start preserves an armed double down", () => {
  const controller = makeController(PHASES.ANSWER_REVEAL, 0);
  controller.game.doubleDownArmed = true;
  controller.game.playerScore = 1000;
  controller.game.fakeScoreTurnsRemaining = 0;
  controller.game.pointShieldNext = false;
  controller.refreshDoubleDownPolicy = () => {};

  controller.handleQuestionStarted({
    questionIndex: 1,
    questionNumber: 2,
    questionCount: 3,
    endsAt: Date.now() + 60000,
    options: []
  });

  assert.equal(controller.game.phase, PHASES.QUESTION);
  assert.equal(controller.game.doubleDownArmed, true);
});

test("score update hydrates authoritative double down state", () => {
  const controller = makeController(PHASES.QUESTION, 1);
  controller.game.doubleDownArmed = false;
  controller.game.leaderboard = [];
  controller.game.playerScore = 1000;
  controller.game.playerDisplayedScore = 1000;
  controller.game.strikeAttackers = [];
  controller.game.isScoreMasked = false;
  controller.refreshDoubleDownPolicy = () => {};
  controller.buildStrikeNotice = () => "";

  controller.handleScoreUpdated({
    leaderboard: [{
      playerId: "local-player",
      rank: 1,
      score: 1000,
      doubleDownArmed: true,
      strikeAttackers: []
    }]
  });

  assert.equal(controller.game.doubleDownArmed, true);
});
