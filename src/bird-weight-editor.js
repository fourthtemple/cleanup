import * as THREE from "../node_modules/three/build/three.module.js";
import { GLTFLoader } from "../node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "../node_modules/three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "../node_modules/three/examples/jsm/exporters/GLTFExporter.js";
import * as SkeletonUtils from "../node_modules/three/examples/jsm/utils/SkeletonUtils.js";
import { OrbitControls } from "../node_modules/three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "../node_modules/three/examples/jsm/controls/TransformControls.js";
import {
  cloneClipWithStartDeleted,
  cloneClipWithStartOffsetApplied,
  configuredClipStartOffsetSeconds,
  remainingClipStartOffsetSeconds
} from "./animation/animation-clip-utils.js";
import { loadBirdFlapProfile } from "./animation/bird-flap-pose.js";
import { installAssetExportMethods } from "./weight-editor/asset-export.js?v=tutorial-macro-reset-20260605a";
import { installAnimationLibraryMethods } from "./weight-editor/animation-library.js?v=help-demo-clean-slate-20260605a";
import { installActorAndModelMethods } from "./weight-editor/actors-and-models.js?v=tutorial-help-safe-20260605a";
import { installClonePaintMethods } from "./weight-editor/clone-paint.js?v=tutorial-macro-reset-20260605a";
import { installClonePaintReplayMethods } from "./weight-editor/clone-paint-replay.js?v=airbrush-command-20260602a";
import { installCurveEditorMethods } from "./weight-editor/curve-editor.js";
import { installCurveHandleMethods } from "./weight-editor/curve-handles.js";
import { installAutoKeySolverMethods } from "./weight-editor/auto-key-solver.js?v=blank-bone-select-20260605a";
import { installJointConstraintMethods } from "./weight-editor/joint-constraints.js?v=joint-limit-capture-20260604a";
import { installOverlayAndRenderMethods } from "./weight-editor/overlays-and-render.js?v=joint-limit-min-max-20260604b";
import { installPaintToolMethods } from "./weight-editor/paint-tools.js?v=safari-picker-webgl-20260602b";
import { installPoseCoreMethods } from "./weight-editor/pose-core.js";
import { installPoseClipboardMethods } from "./weight-editor/pose-clipboard.js";
import { installPoseTimelineMethods } from "./weight-editor/pose-timeline.js?v=blank-bone-select-20260605a";
import { installIkSolverMethods } from "./weight-editor/ik-solver.js?v=inferred-limb-ik-20260605b";
import { installLoopBlendMethods } from "./weight-editor/loop-blend.js";
import { installRigEditorMethods } from "./weight-editor/rig-editor.js?v=blank-bone-select-20260605a";
import { installRootMotionPreviewMethods } from "./weight-editor/root-motion-preview.js";
import { installRootMotionUnbakeMethods } from "./weight-editor/root-motion-unbake.js?v=root-unbake-20260604b";
import { installSceneAndControlMethods } from "./weight-editor/scene-and-controls.js?v=tutorial-help-safe-20260605a";
import { installSequencePlaybackMethods } from "./weight-editor/sequence-playback.js";
import { installTextureAirbrushMethods } from "./weight-editor/texture-airbrush.js?v=safari-picker-webgl-20260602b";
import { installTutorialMacroMethods } from "./weight-editor/tutorial-macros.js?v=fk-ik-demo-slot-20260605a";
import { installVertexPatchMethods } from "./weight-editor/vertex-patches.js?v=tutorial-macro-reset-20260605a";
import { installWeightMethods } from "./weight-editor/weights.js";

const BIRD_WEIGHT_PATCH_FILE_NAME = "mixamo-cleanup-weight-patch.json";
const ADDITIVE_POSE_EASE_FRAMES = 8;
const EDIT_ONLY_TOOLS = new Set(["move", "pull", "push"]);
const ACTOR_TARGETS = Object.freeze([
  Object.freeze({
    id: "imported",
    label: "Imported FBX",
    sourceLabel: "Import a raw Mixamo FBX to begin",
    modelUrl: "",
    mode: "embedded-clips",
    displayHeight: 1.8,
    defaultScale: 1,
    defaultAction: "",
    actions: [],
    patchFile: BIRD_WEIGHT_PATCH_FILE_NAME,
    defaultBone: "Hips",
    animationLibraryFolder: ""
  })
]);

const WING_BONES = [
  "LeftShoulder",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "RightShoulder",
  "RightArm",
  "RightForeArm",
  "RightHand"
];

const BODY_BONES = ["Spine", "Spine01", "Spine02", "neck", "Head", "headfront"];

const PREVIEW_PARAMS = {
  shoulderYBase: 0.02,
  shoulderYStroke: 0.06,
  shoulderZBase: 0.03,
  shoulderZStroke: 0.475,
  armYBase: 0.18,
  armYStroke: 0.1,
  armZBase: -0.32,
  armZStroke: 0.52,
  forearmYBase: 0.02,
  forearmYStroke: 0.18,
  forearmZBase: 0.355,
  forearmZStroke: 0.385,
  handYBase: -0.285,
  handYStroke: 0,
  handZBase: 0,
  handZStroke: 0.21,
  bodyX: -0.006,
  bodyY: 0.011
};

const BASE_COLOR = new THREE.Color(0x8f9694);
const SELECTED_COLOR = new THREE.Color(0xf0b85a);
const MODIFIED_COLOR = new THREE.Color(0x4ba9ff);
const SELECTED_MODIFIED_COLOR = new THREE.Color(0xf06fa8);
const CURVE_CHANNELS = Object.freeze({
  x: { label: "Rotate X", min: -1.8, max: 1.8, decimals: 2 },
  y: { label: "Rotate Y", min: -1.8, max: 1.8, decimals: 2 },
  z: { label: "Rotate Z", min: -1.8, max: 1.8, decimals: 2 },
  px: { label: "Move X", min: -30, max: 30, decimals: 3 },
  py: { label: "Move Y", min: -30, max: 30, decimals: 3 },
  pz: { label: "Move Z", min: -30, max: 30, decimals: 3 }
});
const CURVE_CHANNEL_KEYS = Object.keys(CURVE_CHANNELS);
const RIG_BONE_GROUPS = Object.freeze([
  { id: "all", label: "All", pattern: /./ },
  { id: "body", label: "Body", pattern: /(hips|spine|neck|head|pelvis|chest)/i },
  { id: "arms", label: "Arms", pattern: /(shoulder|arm|hand|finger|thumb|wrist|claw)/i },
  { id: "legs", label: "Legs", pattern: /(leg|foot|toe|ankle|knee)/i },
  { id: "tail", label: "Tail", pattern: /(tail)/i },
  { id: "face", label: "Face", pattern: /(head|eye|lid|blink|brow|jaw|mouth|nose|ear|whisker|face)/i }
]);

function finitePoseValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

class BirdWeightEditor {
  constructor() {
    window.mixamoCleanupEditor = this;
    this.installClonePaintReplayConsole?.();
    this.app = document.querySelector(".weight-editor-app");
    this.canvas = document.getElementById("viewer-canvas");
    this.toolButtons = Array.from(document.querySelectorAll("[data-tool]"));
    this.viewModeButtons = Array.from(document.querySelectorAll("[data-view-mode]"));
    this.viewportLayerButtons = Array.from(document.querySelectorAll("[data-viewport-layer]"));
    this.viewportRenderedToggle = document.getElementById("viewport-rendered-toggle");
    this.viewportMeshToggle = document.getElementById("viewport-mesh-toggle");
    this.viewportSelectionToggle = document.getElementById("viewport-selection-toggle");
    this.undoButton = document.getElementById("undo-edit");
    this.redoButton = document.getElementById("redo-edit");
    this.cleanPreviewButton = document.getElementById("clean-preview");
    this.gizmoOnlyPreviewButton = document.getElementById("gizmo-only-preview");
    this.mirrorModeButton = document.getElementById("mirror-mode");
    this.saveOrbitViewButton = document.getElementById("save-orbit-view");
    this.restoreOrbitViewButton = document.getElementById("restore-orbit-view");
    this.characterSelect = document.getElementById("weight-character-select");
    this.actionSelect = document.getElementById("weight-action-select");
    this.exportFbxButton = document.getElementById("export-fbx-button");
    this.fbxExportTargetSelect = document.getElementById("fbx-export-target");
    this.exportGlbButton = document.getElementById("export-glb-button");
    this.unbakeRootMotionButton = document.getElementById("unbake-root-motion");
    this.animationLibraryFolderSelect = document.getElementById("animation-library-folder-select");
    this.animationLibraryFolderName = document.getElementById("animation-library-folder-name");
    this.createAnimationLibraryFolderButton = document.getElementById("create-animation-library-folder");
    this.animationLibraryImportButton = document.getElementById("animation-library-import-button");
    this.animationLibrarySaveAsButton = document.getElementById("animation-library-save-as");
    this.animationLibrarySaveAsRow = document.getElementById("animation-library-save-as-row");
    this.animationLibrarySaveAsNameInput = document.getElementById("animation-library-save-as-name");
    this.animationLibrarySaveAsOkButton = document.getElementById("animation-library-save-as-ok");
    this.animationLibrarySaveAsCancelButton = document.getElementById("animation-library-save-as-cancel");
    this.animationLibraryFileInput = document.getElementById("animation-library-file");
    this.animationLibraryRefreshButton = document.getElementById("animation-library-refresh");
    this.animationLibraryList = document.getElementById("animation-library-list");
    this.timelineBlendActionSelect = document.getElementById("timeline-blend-action-select");
    this.transferCleanupToBlendButton = document.getElementById("transfer-cleanup-to-blend");
    this.timelineBlendControl = document.getElementById("timeline-blend-control");
    this.timelineBlendOutput = document.getElementById("timeline-blend-output");
    this.rigPanel = document.querySelector(".rig-bone-panel");
    this.rigPanelToggle = document.getElementById("rig-panel-toggle");
    this.rigPanelBody = document.getElementById("rig-panel-body");
    this.rigBoneSearch = document.getElementById("rig-bone-search");
    this.rigBoneGroups = document.getElementById("rig-bone-groups");
    this.rigBoneList = document.getElementById("rig-bone-list");
    this.addBoneParentSelect = document.getElementById("add-bone-parent-select");
    this.addBoneNameInput = document.getElementById("add-bone-name");
    this.addBonePosX = document.getElementById("add-bone-pos-x");
    this.addBonePosY = document.getElementById("add-bone-pos-y");
    this.addBonePosZ = document.getElementById("add-bone-pos-z");
    this.addBoneRotX = document.getElementById("add-bone-rot-x");
    this.addBoneRotY = document.getElementById("add-bone-rot-y");
    this.addBoneRotZ = document.getElementById("add-bone-rot-z");
    this.addBoneButton = document.getElementById("add-bone");
    this.addBoneChainMembersSelect = document.getElementById("add-bone-chain-members");
    this.addBoneChainButton = document.getElementById("add-bone-chain");
    this.jointConstraintEnabled = document.getElementById("joint-constraint-enabled");
    this.jointConstraintXMin = document.getElementById("joint-constraint-x-min");
    this.jointConstraintXMax = document.getElementById("joint-constraint-x-max");
    this.jointConstraintYMin = document.getElementById("joint-constraint-y-min");
    this.jointConstraintYMax = document.getElementById("joint-constraint-y-max");
    this.jointConstraintZMin = document.getElementById("joint-constraint-z-min");
    this.jointConstraintZMax = document.getElementById("joint-constraint-z-max");
    this.jointConstraintClearButton = document.getElementById("joint-constraint-clear");
    this.jointConstraintTemplateName = document.getElementById("joint-constraint-template-name");
    this.jointConstraintTemplateSelect = document.getElementById("joint-constraint-template-select");
    this.jointConstraintSaveTemplateButton = document.getElementById("joint-constraint-save-template");
    this.jointConstraintApplyTemplateButton = document.getElementById("joint-constraint-apply-template");
    this.jointConstraintDeleteTemplateButton = document.getElementById("joint-constraint-delete-template");
    this.jointConstraintCaptureButtons = Array.from(document.querySelectorAll("[data-joint-constraint-capture]"));
    this.placeBoneSelectionButton = document.getElementById("place-bone-selection");
    this.updateBoneButton = document.getElementById("update-bone");
    this.deleteBoneButton = document.getElementById("delete-bone");
    this.boneGizmoButton = document.getElementById("bone-gizmo");
    this.ikGizmoButton = document.getElementById("ik-gizmo");
    this.fkGizmoModeControl = document.getElementById("fk-gizmo-mode-control");
    this.fkGizmoModeInputs = Array.from(document.querySelectorAll('input[name="fk-gizmo-mode"]'));
    this.timelineIkSettings = document.getElementById("timeline-ik-settings");
    this.ikSolverModeSelect = document.getElementById("ik-solver-mode");
    this.ikCounterRotation = document.getElementById("ik-counter-rotation");
    this.ikCounterRotationOutput = document.getElementById("ik-counter-rotation-output");
    this.brushRadius = document.getElementById("brush-radius");
    this.brushRadiusOutput = document.getElementById("brush-radius-output");
    this.throughSelectionToggle = document.getElementById("through-selection-toggle");
    this.sculptStrength = document.getElementById("sculpt-strength");
    this.sculptStrengthOutput = document.getElementById("sculpt-strength-output");
    this.moveSensitivity = document.getElementById("move-sensitivity");
    this.moveSensitivityOutput = document.getElementById("move-sensitivity-output");
    this.clonePaintSourceButton = document.getElementById("clone-paint-source");
    this.clonePaintTargetButton = document.getElementById("clone-paint-target");
    this.clonePaintToolButton = document.getElementById("clone-paint-tool");
    this.clonePaintClearButton = document.getElementById("clone-paint-clear");
    this.clonePaintCopyJsonButton = document.getElementById("clone-paint-copy-json");
    this.texturePaintColor = document.getElementById("texture-paint-color");
    this.textureBrushRadius = document.getElementById("texture-brush-radius");
    this.textureBrushRadiusOutput = document.getElementById("texture-brush-radius-output");
    this.textureBrushOpacity = document.getElementById("texture-brush-opacity");
    this.textureBrushOpacityOutput = document.getElementById("texture-brush-opacity-output");
    this.textureBrushScatter = document.getElementById("texture-brush-scatter");
    this.textureBrushScatterOutput = document.getElementById("texture-brush-scatter-output");
    this.texturePickColorToolButton = document.getElementById("texture-pick-color-tool");
    this.textureAirbrushToolButton = document.getElementById("texture-airbrush-tool");
    this.textureFillRegionButton = document.getElementById("texture-fill-region");
    this.clonePaintStatus = document.getElementById("clone-paint-status");
    this.cloneSourcePreview = document.getElementById("clone-source-preview");
    this.cloneRegionPreview = document.getElementById("clone-region-preview");
    this.clonePaintJsonOutput = document.getElementById("clone-paint-json-output");
    this.lassoOverlay = document.getElementById("lasso-overlay");
    this.lassoOverlayPath = document.getElementById("lasso-overlay-path");
    this.textureBrushCursor = document.getElementById("texture-brush-cursor");
    this.clearSelectionButton = document.getElementById("clear-selection");
    this.clearAllSelectionButton = document.getElementById("clear-all-selection");
    this.invertSelectionButton = document.getElementById("invert-selection");
    this.boneSelect = document.getElementById("bone-select");
    this.boneChainSelect = document.getElementById("bone-chain-select");
    this.removeWeightButton = document.getElementById("remove-weight");
    this.resetWeightsButton = document.getElementById("reset-weights");
    this.redistributeChainWeightsButton = document.getElementById("redistribute-chain-weights");
    this.selectionInfluenceList = document.getElementById("selection-influence-list");
    this.poseBoneSelect = document.getElementById("pose-bone-select");
    this.poseRotX = document.getElementById("pose-rot-x");
    this.poseRotY = document.getElementById("pose-rot-y");
    this.poseRotZ = document.getElementById("pose-rot-z");
    this.poseRotXValue = document.getElementById("pose-rot-x-value");
    this.poseRotYValue = document.getElementById("pose-rot-y-value");
    this.poseRotZValue = document.getElementById("pose-rot-z-value");
    this.posePosX = document.getElementById("pose-pos-x");
    this.posePosY = document.getElementById("pose-pos-y");
    this.posePosZ = document.getElementById("pose-pos-z");
    this.posePosXValue = document.getElementById("pose-pos-x-value");
    this.posePosYValue = document.getElementById("pose-pos-y-value");
    this.posePosZValue = document.getElementById("pose-pos-z-value");
    this.clearPoseButton = document.getElementById("clear-pose");
    this.keyCurrentPoseButton = document.getElementById("key-current-pose");
    this.playToggle = document.getElementById("play-toggle");
    this.timelinePlayToggle = document.getElementById("timeline-play-toggle");
    this.restartClip = document.getElementById("restart-clip");
    this.timeScrub = document.getElementById("time-scrub");
    this.timelineScrub = document.getElementById("timeline-scrub");
    this.timelineKeys = document.getElementById("timeline-keys");
    this.frameReadout = document.getElementById("frame-readout");
    this.prevKeyButton = document.getElementById("prev-key");
    this.nextKeyButton = document.getElementById("next-key");
    this.loopToStartButton = document.getElementById("loop-to-start");
    this.deleteKeyButton = document.getElementById("delete-key");
    this.clearKeysButton = document.getElementById("clear-keys");
    this.boneLayerList = document.getElementById("bone-layer-list");
    this.boneLabelToggle = document.getElementById("bone-label-toggle");
    this.boneLabels = document.getElementById("bone-labels");
    this.speedControl = document.getElementById("speed-control");
    this.speedOutput = document.getElementById("weight-speed-output");
    this.scaleControl = document.getElementById("weight-scale-control");
    this.scaleOutput = document.getElementById("weight-scale-output");
    this.loopToggle = document.getElementById("loop-toggle");
    this.travelLoopToggle = document.getElementById("travel-loop-toggle");
    this.travelFollowToggle = document.getElementById("travel-follow-toggle");
    this.travelFollowOption = document.querySelector(".travel-follow-option");
    this.skeletonToggle = document.getElementById("skeleton-toggle");
    this.weightJson = document.getElementById("weight-json");
    this.savePatchButton = document.getElementById("save-patch");
    this.loadPatchButton = document.getElementById("load-patch");
    this.patchFileInput = document.getElementById("patch-file-input");
    this.copyPatchButton = document.getElementById("copy-patch");
    this.applyPatchJsonButton = document.getElementById("apply-patch-json");
    this.clearPatchButton = document.getElementById("clear-patch");
    this.repairSeamsButton = document.getElementById("repair-seams");
    this.selectionCount = document.getElementById("selection-count");
    this.patchCount = document.getElementById("patch-count");
    this.keyCount = document.getElementById("key-count");
    this.source = document.getElementById("clip-source");
    this.status = document.getElementById("viewer-status");
    this.sidePanelToggle = document.getElementById("side-panel-toggle");
    this.sidePanelShowToggle = document.getElementById("side-panel-show-toggle");
    this.tutorialsToggle = document.getElementById("tutorials-toggle");
    this.tutorialBackdrop = document.getElementById("tutorial-backdrop");
    this.tutorialDrawer = document.getElementById("tutorial-drawer");
    this.tutorialEditButton = document.getElementById("tutorial-edit");
    this.tutorialSaveButton = document.getElementById("tutorial-save");
    this.tutorialCancelButton = document.getElementById("tutorial-cancel");
    this.tutorialResetButton = document.getElementById("tutorial-reset");
    this.tutorialMacroRecordButton = document.getElementById("tutorial-macro-record");
    this.tutorialMacroStopButton = document.getElementById("tutorial-macro-stop");
    this.tutorialDemoControls = document.getElementById("tutorial-demo-controls");
    this.tutorialMacroPlayButton = document.getElementById("tutorial-macro-play");
    this.tutorialMacroSpeedSelect = document.getElementById("tutorial-macro-speed");
    this.tutorialMacroScrubInput = document.getElementById("tutorial-macro-scrub");
    this.tutorialCloseButton = document.getElementById("tutorial-close");
    this.timelineCompactToggle = document.getElementById("timeline-compact-toggle");
    this.timelineHideToggle = document.getElementById("timeline-hide-toggle");
    this.timelineShowToggle = document.getElementById("timeline-show-toggle");
    this.useTimelineKeysToggle = document.getElementById("use-timeline-keys");
    this.adaptiveEditToggle = document.getElementById("adaptive-edit-mode");
    this.solvedKeyDetail = document.getElementById("solved-key-detail");
    this.solvedKeyDetailOutput = document.getElementById("solved-key-detail-output");
    this.cameraGizmo = document.getElementById("camera-gizmo");
    this.cameraGizmoPad = document.getElementById("camera-gizmo-pad");
    this.cameraRollLeftButton = document.getElementById("camera-roll-left");
    this.cameraRollRightButton = document.getElementById("camera-roll-right");
    this.cameraRollResetButton = document.getElementById("camera-roll-reset");
    this.cameraGizmoSpeed = document.getElementById("camera-gizmo-speed");
    this.cameraGizmoSpeedOutput = document.getElementById("camera-gizmo-speed-output");
    this.cameraBackgroundColor = document.getElementById("camera-background-color");
    this.cameraAmbientLight = document.getElementById("camera-ambient-light");
    this.cameraAmbientLightOutput = document.getElementById("camera-ambient-light-output");
    this.cameraKeyLight = document.getElementById("camera-key-light");
    this.cameraKeyLightOutput = document.getElementById("camera-key-light-output");
    this.cameraRimLight = document.getElementById("camera-rim-light");
    this.cameraRimLightOutput = document.getElementById("camera-rim-light-output");
    this.cameraTextureGain = document.getElementById("camera-texture-gain");
    this.cameraTextureGainOutput = document.getElementById("camera-texture-gain-output");
    this.timelinePlayBothButton = document.getElementById("timeline-play-both");
    this.timelineSequenceScrub = document.getElementById("timeline-sequence-scrub");
    this.sequenceReadout = document.getElementById("sequence-readout");
    this.sequencePhaseTrack = document.getElementById("sequence-phase-track");
    this.sequenceSourceReadout = document.getElementById("sequence-source-readout");
    this.sequenceMixReadout = document.getElementById("sequence-mix-readout");
    this.sequenceTargetReadout = document.getElementById("sequence-target-readout");

    this.loader = new GLTFLoader();
    this.fbxLoader = new FBXLoader();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.modelRoot = new THREE.Group();
    this.actorTarget = ACTOR_TARGETS[0];
    this.animationLibrarySelectedFolder = this.actorTarget.animationLibraryFolder || "";
    this.loadToken = 0;
    this.model = null;
    this.baseModelScale = 1;
    this.actorScaleMultiplier = 1;
    this.mixer = null;
    this.activeClipAction = null;
    this.activeClipEntry = null;
    this.blendClipAction = null;
    this.blendClipEntry = null;
    this.blendActionId = "";
    this.fbxExportTarget = this.fbxExportTargetSelect?.value || "threejs";
    this.clipEntries = [];
    this.clipCleanupEdits = new Map();
    this.lastClipSampleTime = null;
    this.animationLibraryFolders = [];
    this.birdFlapParams = { ...PREVIEW_PARAMS };
    this.birdPreviewUsesFlapParams = false;
    this.bindPose = [];
    this.bones = new Map();
    this.paintRecords = [];
    this.clonePaintSource = null;
    this.clonePaintTargets = new Map();
    this.cloneSpotlightOverlays = [];
    this.cloneSpotlightActive = false;
    this.lassoStroke = null;
    this.activeTool = "paint";
    this.activeBoneName = "";
    this.selectedBoneChainRootName = "";
    this.rigBoneGroup = "all";
    this.rigBoneSearchText = "";
    this.viewMode = "rendered";
    this.showRenderedLayer = true;
    this.showMeshLayer = false;
    this.showSelectionLayer = true;
    this.showBonesLayer = false;
    this.cleanPreview = false;
    this.gizmoOnlyPreview = false;
    this.mirrorMode = false;
    this.backgroundColor = this.cameraBackgroundColor?.value || "#11171c";
    const controlNumber = (control, fallback) => {
      const value = Number(control?.value);
      return Number.isFinite(value) ? value : fallback;
    };
    this.sceneLightLevels = {
      ambient: controlNumber(this.cameraAmbientLight, 0.75),
      key: controlNumber(this.cameraKeyLight, 1.25),
      rim: controlNumber(this.cameraRimLight, 0.35)
    };
    this.textureGain = controlNumber(this.cameraTextureGain, 1);
    this.manualPose = new Map();
    this.manualPoseEditedChannels = new Map();
    this.poseKeyframes = new Map();
    this.poseCurveHandles = new Map();
    this.poseClipboard = null;
    this.poseKeyframeMode = "additive";
    this.poseKeyframesGenerated = false;
    this.timelineKeysSourceWasAutoGenerated = false;
    this.virtualBones = [];
    this.manualBoneChains = [];
    this.ikChainSettings = new Map();
    this.fkGizmoMode = this.fkGizmoModeInputs.find((input) => input.checked)?.value || "rotate";
    this.jointConstraints = new Map();
    this.jointConstraintTemplates = null;
    this.jointConstraintEditedPoseBone = "";
    this.jointConstraintEditedPoseChannels = new Set();
    this.boneLayerNames = [];
    this.bonePickerNames = [];
    this.moveDrag = null;
    this.boneMoveDrag = null;
    this.ikTarget = null;
    this.ikTargetMarker = null;
    this.ikTargetGizmoArmed = false;
    this.ikDrag = null;
    this.playing = false;
    this.draggingScrub = false;
    this.draggingPoseControl = false;
    this.painting = false;
    this.selectionStrokeUndo = null;
    this.neighborStroke = null;
    this.cameraGizmoDrag = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 40;
    this.historyRestoreBusy = false;
    this.pendingHistoryStep = null;
    this.markerVertexCount = 0;
    this.vertexMarkerCount = 0;
    this.progress = 0;
    this.timelineFrames = 96;
    this.sequencePlaying = false;
    this.sequenceElapsed = 0;
    this.sequenceRootAnchor = null;
    this.sequenceTargetRootStart = null;
    this.rootMotionLoopCycles = 0;
    this.rootMotionLoopProfileCache = null;
    this.rootMotionCameraFollowPoint = null;
    this.rootMotionUnbakeActions = new Map();
    this.timelineReadoutLastUpdate = 0;
    this.timelineReadoutIntervalMs = 300;
    this.playbackReadoutLastUpdate = 0;
    this.playbackReadoutIntervalMs = 180;
    this.sequenceReadoutLastUpdate = 0;
    this.sequenceReadoutIntervalMs = 180;
    this.curveReadoutLastUpdate = 0;
    this.curveReadoutIntervalMs = 600;
    this.boneLayerValueNodes = [];
    this.pendingBonePlacement = false;
    this.boneMoveGizmoArmed = false;
    this.expandedBoneName = "";
    this.curveChannelKey = "y";
    this.curveCanvas = null;
    this.curveContext = null;
    this.curvePlayhead = null;
    this.curveReadout = null;
    this.curveDragging = null;
    this.lastFrameTime = performance.now();

    this.tempVector = new THREE.Vector3();
    this.tempWorld = new THREE.Vector3();
    this.tempNormal = new THREE.Vector3();
    this.tempWorldDelta = new THREE.Vector3();
    this.tempMatrix = new THREE.Matrix4();
    this.tempSkinMatrix = new THREE.Matrix4();
    this.tempWeightedSkinMatrix = new THREE.Matrix4();
    this.tempBoneMatrix = new THREE.Matrix4();
    this.tempNormalMatrix = new THREE.Matrix3();
    this.tempLocalA = new THREE.Vector3();
    this.tempLocalB = new THREE.Vector3();
    this.tempDesiredWorld = new THREE.Vector3();
    this.tempDesiredLocal = new THREE.Vector3();
    this.tempWorldNormal = new THREE.Vector3();

    this.createScene();
    this.renderCharacterOptions();
    this.bindControls();
    this.setPlayback(false);
    void this.refreshAnimationLibrary?.({ silent: true });
    this.setSidePanelOpen(this.app?.classList.contains("is-side-panel-open"));
    this.renderActionOptions();
    this.syncTravelFollowControls?.();
    this.syncTimelineControls();
    this.syncPatchJson();
    this.syncPoseClipboardControls?.();
    this.syncExportButtons?.();
    if (this.source) {
      this.source.textContent = this.actorTarget?.sourceLabel || "Import a raw Mixamo FBX to begin";
    }
    this.setStatus("Import a raw Mixamo FBX to begin");
    this.animate();
  }
}

const BIRD_WEIGHT_EDITOR_DEPS = {
  THREE,
  FBXLoader,
  GLTFExporter,
  SkeletonUtils,
  OrbitControls,
  TransformControls,
  cloneClipWithStartDeleted,
  cloneClipWithStartOffsetApplied,
  configuredClipStartOffsetSeconds,
  remainingClipStartOffsetSeconds,
  loadBirdFlapProfile,
  BIRD_WEIGHT_PATCH_FILE_NAME,
  ACTOR_TARGETS,
  WING_BONES,
  BODY_BONES,
  PREVIEW_PARAMS,
  BASE_COLOR,
  SELECTED_COLOR,
  MODIFIED_COLOR,
  SELECTED_MODIFIED_COLOR,
  CURVE_CHANNELS,
  CURVE_CHANNEL_KEYS,
  ADDITIVE_POSE_EASE_FRAMES,
  RIG_BONE_GROUPS,
  EDIT_ONLY_TOOLS,
  finitePoseValue,
  writeJsonFile,
  writeAnimationLibraryCleanupFile
};

installSceneAndControlMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installAssetExportMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installAnimationLibraryMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installActorAndModelMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installClonePaintMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installClonePaintReplayMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installRigEditorMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installIkSolverMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installJointConstraintMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installPaintToolMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installWeightMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installVertexPatchMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installPoseCoreMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installPoseClipboardMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installPoseTimelineMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installCurveHandleMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installLoopBlendMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installSequencePlaybackMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installRootMotionPreviewMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installRootMotionUnbakeMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installOverlayAndRenderMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installCurveEditorMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installAutoKeySolverMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installTextureAirbrushMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);
installTutorialMacroMethods(BirdWeightEditor, BIRD_WEIGHT_EDITOR_DEPS);


async function writeJsonFile(fileName, text, description) {
  if (typeof window.showSaveFilePicker === "function") {
    const handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [{
        description,
        accept: { "application/json": [".json"] }
      }]
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return "file";
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "download";
}

async function writeAnimationLibraryCleanupFile(folder, fileName, text) {
  const browserStorage = window.telekinetikittyAnimationLibraryStorage;
  if (browserStorage) {
    try {
      await browserStorage.saveCleanup({ folder, fileName, content: text });
      return true;
    } catch (error) {
      console.warn("Could not save browser cleanup file", error);
      return false;
    }
  }
  try {
    const response = await fetch("/api/animation-library/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, fileName, content: text })
    });
    return response.ok;
  } catch {
    return false;
  }
}

new BirdWeightEditor();
