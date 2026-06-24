import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

class TestEditor {}

installSceneAndControlMethods(TestEditor, {
  THREE,
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});

function classListMock(initial = []) {
  const names = new Set(initial);
  return {
    add(...items) {
      items.forEach((item) => names.add(item));
    },
    remove(...items) {
      items.forEach((item) => names.delete(item));
    },
    contains(item) {
      return names.has(item);
    },
    toggle(item, force) {
      const next = force === undefined ? !names.has(item) : Boolean(force);
      if (next) {
        names.add(item);
      } else {
        names.delete(item);
      }
      return next;
    }
  };
}

function attributeButton() {
  const attrs = new Map();
  return {
    attrs,
    textContent: "",
    title: "",
    setAttribute(name, value) {
      attrs.set(name, value);
    }
  };
}

test("compact cleanup timeline hides curve and sequence-only areas", () => {
  const css = fs.readFileSync(path.join(repoRoot, "src/animation-viewer.css"), "utf8");
  assert.match(css, /\.weight-editor-app\.is-timeline-compact \.bone-layer-list/);
  assert.match(css, /\.weight-editor-app\.is-timeline-compact \.timeline-sequence-row/);
});

test("side panel pen drag scrolls panel content without grabbing controls", () => {
  const editor = new TestEditor();
  const app = { classList: classListMock() };
  let capturedPointer = null;
  let releasedPointer = null;
  let prevented = 0;
  let stopped = 0;
  let selectionCleared = 0;
  editor.app = app;
  editor.viewerPanelScroll = {
    scrollLeft: 3,
    scrollTop: 40,
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    },
    releasePointerCapture(pointerId) {
      releasedPointer = pointerId;
    }
  };
  const interactiveTarget = {
    closest() {
      return {};
    }
  };
  const panelTextTarget = {
    closest() {
      return null;
    }
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    getSelection() {
      return {
        removeAllRanges() {
          selectionCleared += 1;
        }
      };
    }
  };

  try {
    assert.equal(editor.beginSidePanelPenScroll({
      pointerType: "pen",
      button: 0,
      pointerId: 8,
      clientX: 12,
      clientY: 10,
      target: interactiveTarget
    }), false);

    assert.equal(editor.beginSidePanelPenScroll({
      pointerType: "pen",
      button: 0,
      pointerId: 8,
      clientX: 12,
      clientY: 10,
      target: panelTextTarget
    }), true);
    assert.equal(capturedPointer, 8);
    assert.equal(editor.dragSidePanelPenScroll({
      pointerId: 8,
      clientX: 13,
      clientY: 12,
      preventDefault() {
        prevented += 1;
      },
      stopPropagation() {
        stopped += 1;
      }
    }), false);
    assert.equal(prevented, 0);
    assert.equal(editor.dragSidePanelPenScroll({
      pointerId: 8,
      clientX: 10,
      clientY: 30,
      preventDefault() {
        prevented += 1;
      },
      stopPropagation() {
        stopped += 1;
      }
    }), true);
    assert.equal(editor.viewerPanelScroll.scrollLeft, 5);
    assert.equal(editor.viewerPanelScroll.scrollTop, 20);
    assert.equal(app.classList.contains("is-side-panel-pen-scrolling"), true);
    assert.equal(selectionCleared, 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(editor.endSidePanelPenScroll({
      pointerId: 8,
      preventDefault() {
        prevented += 1;
      },
      stopPropagation() {
        stopped += 1;
      }
    }), true);
    assert.equal(releasedPointer, 8);
    assert.equal(app.classList.contains("is-side-panel-pen-scrolling"), false);
    assert.equal(prevented, 2);
    assert.equal(stopped, 2);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("side panel pen drag scroll accepts Safari tablet mouse-shaped pointer events", () => {
  const editor = new TestEditor();
  const app = { classList: classListMock() };
  let capturedPointer = null;
  let prevented = 0;
  let stopped = 0;
  let selectionCleared = 0;
  editor.app = app;
  editor.viewerPanelScroll = {
    scrollLeft: 12,
    scrollTop: 30,
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    },
    releasePointerCapture() {}
  };
  const panelTextTarget = {
    closest() {
      return null;
    }
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    onwebkitmouseforcechanged: null,
    getSelection() {
      return {
        removeAllRanges() {
          selectionCleared += 1;
        }
      };
    }
  };

  try {
    assert.equal(editor.beginSidePanelPenScroll({
      pointerType: "mouse",
      button: 0,
      pointerId: 12,
      clientX: 20,
      clientY: 40,
      target: panelTextTarget
    }), true);
    assert.equal(capturedPointer, 12);

    assert.equal(editor.dragSidePanelPenScroll({
      pointerId: 12,
      clientX: 15,
      clientY: 64,
      preventDefault() {
        prevented += 1;
      },
      stopPropagation() {
        stopped += 1;
      }
    }), true);

    assert.equal(editor.viewerPanelScroll.scrollLeft, 17);
    assert.equal(editor.viewerPanelScroll.scrollTop, 6);
    assert.equal(app.classList.contains("is-side-panel-pen-scrolling"), true);
    assert.equal(selectionCleared, 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("opening the timeline drawer does not auto-expand the selected or first bone", () => {
  const editor = new TestEditor();
  editor.app = { classList: classListMock(["is-timeline-compact"]) };
  editor.timelineCompactToggle = attributeButton();
  editor.boneLayerNames = ["LeftShoulder", "RightShoulder"];
  editor.expandedBoneName = null;
  editor.poseBoneSelect = { value: "LeftShoulder" };
  editor.restoreTimelineDrawerHeight = () => 520;
  editor.applyTimelineDrawerHeight = () => 520;
  editor.timelineDrawerHasCurveContent = () => true;
  editor.updateBoneLayerListCalls = 0;
  editor.updateBoneLayerList = () => {
    editor.updateBoneLayerListCalls += 1;
  };
  editor.resize = () => {};

  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const queuedFrames = [];
  globalThis.requestAnimationFrame = (callback) => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  };
  try {
    editor.setTimelineCompact(false, { fitContent: false, status: false });
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }

  assert.equal(editor.app.classList.contains("is-timeline-compact"), false);
  assert.equal(editor.expandedBoneName, null);
  assert.equal(editor.updateBoneLayerListCalls, 1);
});

test("small downward drawer drag compacts without hiding", () => {
  const editor = new TestEditor();
  const panel = { scrollTop: 22 };
  editor.app = { classList: classListMock(["is-timeline-drawer-dragging"]) };
  editor.timelineCompactToggle = attributeButton();
  editor.boneLayerNames = ["LeftShoulder"];
  editor.timelineDrawerHasCurveContent = () => true;
  editor.timelineDrawerMinimumHeight = () => 120;
  editor.timelineDrawerCloseDistance = () => 32;
  editor.applyTimelineDrawerHeightCalls = [];
  editor.applyTimelineDrawerHeight = (height, options) => {
    editor.applyTimelineDrawerHeightCalls.push({ height, options });
    return height;
  };
  editor.applyTimelineDrawerDragOffset = (offset) => {
    editor.lastDragOffset = offset;
  };
  editor.timelineDrawerPanel = () => panel;
  editor.resize = () => {};
  editor.hideTimelineDrawer = () => {
    throw new Error("drag minimize should not hide the timeline");
  };
  editor.timelineDrawerDrag = {
    pointerId: 9,
    latestHeight: 150,
    latestDeltaY: 80,
    startCompact: false,
    startHeight: 300,
    latestPullPastMinimum: 10,
    captureElement: { releasePointerCapture() {} }
  };

  const originalWindow = globalThis.window;
  globalThis.window = {
    removeEventListener() {}
  };
  try {
    editor.endTimelineDrawerDrag({
      pointerId: 9,
      preventDefault() {}
    });
  } finally {
    globalThis.window = originalWindow;
  }

  assert.equal(editor.app.classList.contains("is-timeline-compact"), true);
  assert.equal(editor.app.classList.contains("is-timeline-hidden"), false);
  assert.equal(panel.scrollTop, 0);
  assert.equal(editor.lastDragOffset, 0);
});

test("large downward drawer drag closes to the bottom tip from compact state", () => {
  const editor = new TestEditor();
  const panel = { scrollTop: 22 };
  editor.app = { classList: classListMock(["is-timeline-drawer-dragging"]) };
  editor.timelineCompactToggle = attributeButton();
  editor.boneLayerNames = ["LeftShoulder"];
  editor.timelineDrawerHasCurveContent = () => true;
  editor.timelineDrawerMinimumHeight = () => 120;
  editor.timelineDrawerCloseDistance = () => 32;
  editor.applyTimelineDrawerHeightCalls = [];
  editor.applyTimelineDrawerHeight = (height, options) => {
    editor.applyTimelineDrawerHeightCalls.push({ height, options });
    return height;
  };
  editor.applyTimelineDrawerDragOffset = (offset) => {
    editor.lastDragOffset = offset;
  };
  editor.timelineDrawerPanel = () => panel;
  editor.resize = () => {};
  editor.hideTimelineDrawer = () => {
    editor.hideTimelineDrawerCalled = true;
    editor.app.classList.add("is-timeline-hidden");
  };
  editor.timelineDrawerDrag = {
    pointerId: 10,
    latestHeight: 120,
    latestDeltaY: 48,
    startCompact: true,
    startHeight: 140,
    latestPullPastMinimum: 48,
    captureElement: { releasePointerCapture() {} }
  };

  const originalWindow = globalThis.window;
  globalThis.window = {
    removeEventListener() {}
  };
  try {
    editor.endTimelineDrawerDrag({
      pointerId: 10,
      preventDefault() {}
    });
  } finally {
    globalThis.window = originalWindow;
  }

  assert.equal(editor.app.classList.contains("is-timeline-compact"), true);
  assert.equal(editor.app.classList.contains("is-timeline-hidden"), true);
  assert.equal(editor.hideTimelineDrawerCalled, true);
  assert.equal(panel.scrollTop, 0);
  assert.equal(editor.lastDragOffset, 0);
  assert.equal(editor.applyTimelineDrawerHeightCalls[0].height, 120);
});

test("tutorial action opens the bottom timeline drawer when curve content exists", () => {
  const editor = new TestEditor();
  const panel = {
    scrollIntoView(options) {
      editor.scrollOptions = options;
    }
  };
  editor.timelineDrawerHasCurveContent = () => true;
  editor.timelineDrawerCompactHeight = () => 180;
  editor.defaultTimelineDrawerHeight = () => 560;
  editor.boneLayerNames = ["Hips", "mixamorigLeftShoulder", "RightShoulder"];
  editor.bones = new Map(editor.boneLayerNames.map((name) => [name, {}]));
  editor.setActiveBone = (name, options) => {
    editor.activeBoneName = name;
    editor.setActiveBoneOptions = options;
  };
  editor.clampTimelineDrawerHeight = (height, options) => {
    editor.clampOptions = options;
    return Math.round(height);
  };
  editor.timelineDrawerPanel = () => panel;
  editor.setTimelineHidden = (hidden) => {
    editor.timelineHidden = hidden;
  };
  editor.setTimelineCompact = (compact, options) => {
    editor.timelineCompact = compact;
    editor.timelineCompactOptions = options;
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.openTimelineDrawerForTutorial(), true);
  assert.equal(editor.timelineHidden, false);
  assert.equal(editor.timelineCompact, false);
  assert.equal(editor.activeBoneName, "mixamorigLeftShoulder");
  assert.deepEqual(editor.setActiveBoneOptions, {
    preserveBoneChainMemberSelection: true,
    suppressBoneChainAutoSelect: true
  });
  assert.equal(editor.expandedBoneName, "mixamorigLeftShoulder");
  assert.equal(editor.pendingCurveScrollBoneName, "mixamorigLeftShoulder");
  assert.equal(editor.timelineCompactOptions.height, 364);
  assert.equal(editor.timelineCompactOptions.fitContent, false);
  assert.equal(editor.timelineCompactOptions.minHeight, 180);
  assert.equal(editor.timelineCompactOptions.persist, false);
  assert.equal(editor.timelineCompactOptions.userSized, true);
  assert.deepEqual(editor.clampOptions, { fitContent: false, minHeight: 180 });
  assert.equal(editor.lastStatus, "Opened the timeline drawer");
  assert.deepEqual(editor.scrollOptions, { block: "end", inline: "nearest", behavior: "smooth" });
});

test("tutorial action does not open the bottom timeline drawer without curve content", () => {
  const editor = new TestEditor();
  editor.timelineDrawerHasCurveContent = () => false;
  editor.setTimelineHidden = () => {
    throw new Error("timeline should not open without curve content");
  };
  editor.setTimelineCompact = () => {
    throw new Error("timeline should not expand without curve content");
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.openTimelineDrawerForTutorial(), false);
  assert.equal(editor.lastStatus, "Load or convert keyed motion before opening curve layers");
});
