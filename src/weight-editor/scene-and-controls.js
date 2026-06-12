export function installSceneAndControlMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    ACTOR_TARGETS,
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
    writeJsonFile
  } = deps;
  const ORBIT_VIEW_STORAGE_KEY = "mixamo-cleanup-editor:orbit-view:v1";
  const CAMERA_CONFIGURATION_STORAGE_KEY = "fourth-temple-model-cleanup:camera-configuration:v1";
  const SIDE_PANEL_WIDTH_STORAGE_KEY = "fourth-temple-model-cleanup:side-panel-width:v1";
  const SIDE_PANEL_DEFAULT_WIDTH = 220;
  const SIDE_PANEL_MIN_WIDTH = 150;
  const SIDE_PANEL_MAX_WIDTH = 320;
  const SIDE_PANEL_NARROW_WIDTH = 196;
  const SIDE_PANEL_TIGHT_WIDTH = 174;
  const SIDE_PANEL_SNAP_BACK_RATIO = 1 / 3;
  const SIDE_PANEL_ELASTIC_MIN_WIDTH = 96;
  const SIDE_PANEL_ELASTIC_RESISTANCE = 0.2;
  const SIDE_PANEL_TRANSITION_MS = 180;
  const SIDE_PANEL_EDGE_GESTURE_THRESHOLD = 5;
  const TIMELINE_DRAWER_HEIGHT_STORAGE_KEY = "fourth-temple-model-cleanup:timeline-drawer-height:v1";
  const TIMELINE_DRAWER_MIN_HEIGHT = 430;
  const TIMELINE_DRAWER_SNAP_HEIGHT = 280;
  const TIMELINE_DRAWER_DEFAULT_HEIGHT = 560;
  const TIMELINE_DRAWER_MAX_HEIGHT = 620;
  const TIMELINE_DRAWER_GESTURE_THRESHOLD = 5;
  const TIMELINE_DRAWER_EDGE_GRAB_HEIGHT = 12;
  const TIMELINE_DRAWER_CLOSE_RATIO = 1 / 3;
  const TIMELINE_DRAWER_ELASTIC_RESISTANCE = 0.2;
  const TIMELINE_DRAWER_CLOSE_MS = 180;
  const TUTORIAL_EDITOR_STORAGE_KEY = "fourth-temple-model-cleanup:tutorial-editor-enabled:v1";
  const TUTORIAL_RECIPES_STORAGE_KEY = "fourth-temple-model-cleanup:tutorial-recipes:v1";
  const TUTORIAL_RECIPES_ASSET_URL = "./assets/tutorial-recipes.json?v=20260609a";

  function tutorialLocalStorageGet(key) {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function tutorialLocalStorageSet(key, value) {
    try {
      window.localStorage?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function tutorialLocalStorageRemove(key) {
    try {
      window.localStorage?.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function tutorialMarkdownFromNode(node) {
    let output = "";
    for (const child of node?.childNodes || []) {
      if (child.nodeType === 3) {
        output += child.textContent || "";
      } else if (child.nodeType === 1 && /^(b|strong)$/i.test(child.tagName || "")) {
        output += `**${(child.textContent || "").trim()}**`;
      } else {
        output += tutorialMarkdownFromNode(child);
      }
    }
    return output.replace(/\s+/g, " ").trim();
  }

  function appendTutorialMarkdown(target, value) {
    const parts = String(value || "").split(/(\*\*[^*]+\*\*)/g);
    for (const part of parts) {
      if (!part) {
        continue;
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const bold = document.createElement("b");
        bold.textContent = part.slice(2, -2);
        target.append(bold);
      } else {
        target.append(document.createTextNode(part));
      }
    }
  }

  function normalizedTutorialStep(step, fallback = {}) {
    if (typeof step === "string") {
      return {
        text: step.trim(),
        targets: fallback.targets || "",
        action: fallback.action || "",
        macro: fallback.macro || ""
      };
    }
    return {
      text: String(step?.text || fallback.text || "").trim(),
      targets: String(step?.targets || fallback.targets || ""),
      action: String(step?.action || fallback.action || ""),
      macro: String(step?.macro || fallback.macro || "")
    };
  }

  function normalizedTutorialCard(card, fallback = {}) {
    const fallbackSteps = Array.isArray(fallback.steps) ? fallback.steps : [];
    const rawSteps = Array.isArray(card?.steps) && card.steps.length ? card.steps : fallbackSteps;
    return {
      title: String(card?.title || fallback.title || "Recipe").trim(),
      targets: String(card?.targets || fallback.targets || ""),
      steps: rawSteps.map((step, index) => normalizedTutorialStep(step, fallbackSteps[index] || { targets: fallback.targets || "" }))
    };
  }

  function normalizeTutorialRecipeMacros(cards = []) {
    for (const card of cards) {
      if (!/fk\s*\/?\s*ik/i.test(card?.title || "") || !Array.isArray(card.steps)) {
        continue;
      }
      const hasFkIkMacro = card.steps.some((step) => step?.macro === "fk-ik");
      if (!hasFkIkMacro) {
        continue;
      }
      for (const step of card.steps) {
        if (step?.macro === "fk-ik") {
          step.macro = "";
        }
      }
      const lastStep = card.steps.at(-1);
      if (lastStep) {
        lastStep.macro = "fk-ik";
      }
    }
    return cards;
  }

  function finiteVectorArray(value, length = 3) {
    return Array.isArray(value)
      && value.length === length
      && value.every((entry) => Number.isFinite(Number(entry)));
  }

  Object.assign(BirdWeightEditor.prototype, {
    createScene() {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.applyBackgroundColor(this.backgroundColor || "#11171c");
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(this.backgroundColor || "#11171c", 30, 140);
      this.applyBackgroundColor(this.backgroundColor || "#11171c");
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
      this.camera.position.set(0, 1.35, 4.2);

      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.target.set(0, 0.92, 0);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.minDistance = 1.4;
      this.controls.maxDistance = 120;
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      };
      this.controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN
      };
      this.controls.screenSpacePanning = true;
      this.controls.addEventListener("start", () => this.flushTextureAirbrushScreenStroke?.());
      this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

      this.ambientSceneLight = new THREE.HemisphereLight(0xf4dec4, 0x25303b, 1);
      this.scene.add(this.ambientSceneLight);

      const key = new THREE.DirectionalLight(0xffe2b8, 1);
      key.position.set(3.4, 4.2, 4.5);
      this.keySceneLight = key;
      this.scene.add(key);

      const rim = new THREE.DirectionalLight(0x8bb7ff, 1);
      rim.position.set(-3.6, 2.4, -2.8);
      rim.target.position.copy(this.controls.target);
      this.rimSceneLight = rim;
      this.scene.add(rim);
      this.scene.add(rim.target);
      this.applySceneLighting();

      const grid = new THREE.GridHelper(8, 32, 0xdfb45d, 0x35434a);
      grid.name = "ground reference grid";
      grid.material.transparent = true;
      grid.material.opacity = 0.32;
      grid.material.depthWrite = false;
      grid.renderOrder = 1;
      this.groundGrid = grid;
      this.scene.add(grid);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(4, 72),
        new THREE.MeshBasicMaterial({
          color: 0x172026,
          transparent: true,
          opacity: 0.72,
          depthWrite: false
        })
      );
      floor.name = "ground reference floor";
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.012;
      floor.renderOrder = 0;
      this.groundFloor = floor;
      this.scene.add(floor);

      this.markerGeometry = new THREE.BufferGeometry();
      this.markerMaterial = new THREE.PointsMaterial({
        size: 4,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        depthTest: true,
        depthWrite: false
      });
      this.selectionMarkers = new THREE.Points(this.markerGeometry, this.markerMaterial);
      this.selectionMarkers.frustumCulled = false;
      this.selectionMarkers.renderOrder = 20;
      this.scene.add(this.selectionMarkers);

      this.selectedBoneLineGeometry = new THREE.BufferGeometry();
      this.selectedBoneLine = new THREE.LineSegments(
        this.selectedBoneLineGeometry,
        new THREE.LineBasicMaterial({
          color: 0xffd36e,
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false
        })
      );
      this.selectedBoneLine.renderOrder = 30;
      this.scene.add(this.selectedBoneLine);

      this.selectedBoneJointGeometry = new THREE.BufferGeometry();
      this.selectedBoneJoints = new THREE.Points(
        this.selectedBoneJointGeometry,
        new THREE.PointsMaterial({
          color: 0xfff0b5,
          size: 13,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.96,
          depthTest: false,
          depthWrite: false
        })
      );
      this.selectedBoneJoints.renderOrder = 31;
      this.scene.add(this.selectedBoneJoints);

      this.bonePickerLineGeometry = new THREE.BufferGeometry();
      this.bonePickerLines = new THREE.LineSegments(
        this.bonePickerLineGeometry,
        new THREE.LineBasicMaterial({
          color: 0x78cfff,
          transparent: true,
          opacity: 0.58,
          depthTest: false,
          depthWrite: false
        })
      );
      this.bonePickerLines.renderOrder = 28;
      this.bonePickerLines.visible = false;
      this.scene.add(this.bonePickerLines);

      this.bonePickerGeometry = new THREE.BufferGeometry();
      this.bonePickerJoints = new THREE.Points(
        this.bonePickerGeometry,
        new THREE.PointsMaterial({
          size: 10,
          sizeAttenuation: false,
          vertexColors: true,
          transparent: true,
          opacity: 0.96,
          depthTest: false,
          depthWrite: false
        })
      );
      this.bonePickerJoints.renderOrder = 29;
      this.bonePickerJoints.visible = false;
      this.scene.add(this.bonePickerJoints);

      this.vertexGeometry = new THREE.BufferGeometry();
      this.vertexMaterial = new THREE.PointsMaterial({
        size: 3,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.76,
        depthTest: true,
        depthWrite: false
      });
      this.vertexMarkers = new THREE.Points(this.vertexGeometry, this.vertexMaterial);
      this.vertexMarkers.frustumCulled = false;
      this.vertexMarkers.renderOrder = 12;
      this.vertexMarkers.visible = false;
      this.scene.add(this.vertexMarkers);

      this.meshWireOverlayMaterial = new THREE.MeshBasicMaterial({
        color: this.meshColor || "#80d8ff",
        wireframe: true,
        transparent: true,
        opacity: 0.42,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      this.meshWireOverlays = [];

      this.neighborHoverGeometry = new THREE.BufferGeometry();
      this.neighborHoverMarker = new THREE.Points(
        this.neighborHoverGeometry,
        new THREE.PointsMaterial({
          color: 0x7af7ff,
          size: 14,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false
        })
      );
      this.neighborHoverMarker.frustumCulled = false;
      this.neighborHoverMarker.renderOrder = 34;
      this.neighborHoverMarker.visible = false;
      this.scene.add(this.neighborHoverMarker);

      this.cloneSpotlightSourceMaterial = new THREE.MeshBasicMaterial({
        color: 0x7af7ff,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });
      this.cloneSpotlightRegionMaterial = new THREE.MeshBasicMaterial({
        color: 0xffd36e,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });

      this.selectionPivot = new THREE.Object3D();
      this.selectionPivot.visible = false;
      this.scene.add(this.selectionPivot);

      this.selectionPivotMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffd36e,
          transparent: true,
          opacity: 0.92,
          depthTest: false,
          depthWrite: false
        })
      );
      this.selectionPivotMarker.renderOrder = 32;
      this.selectionPivotMarker.visible = false;
      this.scene.add(this.selectionPivotMarker);

      this.createIkTarget?.();

      this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
      this.transformControls.setMode("translate");
      this.transformControls.setSize(0.72);
      this.transformControls.enabled = false;
      this.transformControls.visible = false;
      this.transformControls.addEventListener("dragging-changed", (event) => {
        if (event.value) {
          if (this.activeTool === "bone" && this.ikTargetGizmoArmed && this.transformControls.object === this.ikTarget) {
            this.beginIkMove();
          } else if (this.activeTool === "bone" && this.boneMoveGizmoArmed) {
            this.beginBoneMove();
          } else {
            this.beginSelectionMove();
          }
          this.pausePlayback();
        } else {
          if (this.ikDrag) {
            this.finishIkMove();
          } else if (this.boneMoveDrag) {
            this.finishBoneMove();
          } else {
            this.finishSelectionMove();
          }
        }
        this.controls.enabled = event.value ? false : this.activeTool === "orbit" || this.activeTool === "bone";
      });
      this.transformControls.addEventListener("objectChange", () => {
        if (this.ikDrag) {
          this.applyIkMove();
        } else if (this.boneMoveDrag) {
          this.applyBoneMove();
        } else {
          this.applySelectionMove();
        }
      });
      this.transformHelper = this.transformControls.getHelper();
      this.transformHelper.visible = false;
      this.scene.add(this.transformHelper);
      this.configureTransformControlHitAreas?.();
      this.canvas.addEventListener("pointermove", (event) => this.updateProjectedTransformGizmoAxis?.(event), { capture: true });
      this.canvas.addEventListener("pointerdown", (event) => this.tryProjectedTransformGizmoPointerDown?.(event), { capture: true });
      this.bindTutorialMacroSceneEvents?.();

      this.scene.add(this.modelRoot);
      this.resize();
      window.addEventListener("resize", () => {
        this.resize();
        this.queueTutorialViewportResize?.();
      });
    },

    configureTransformControlHitAreas() {
      const picker = this.transformControls?._gizmo?.picker?.translate;
      if (!picker || picker.userData.mixamoCleanupHitAreaVersion === 3) {
        return;
      }
      for (const handle of picker.children || []) {
        if (!["X", "Y", "Z"].includes(handle.name)) {
          continue;
        }
        handle.raycast = () => {};
      }
      picker.userData.mixamoCleanupHitAreaVersion = 3;
    },

    transformPointerFromEvent(event) {
      const rect = this.renderer?.domElement?.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) {
        return null;
      }
      return {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
        button: event.button
      };
    },

    transformControlProjectedAxisHit(event) {
      const controls = this.transformControls;
      const object = controls?.object;
      if (!controls?.enabled || !object || controls.dragging || controls.mode !== "translate") {
        return null;
      }
      const rect = this.renderer?.domElement?.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height || !this.camera) {
        return null;
      }

      this.transformHelper?.updateMatrixWorld?.(true);
      const gizmo = controls._gizmo?.gizmo?.translate;
      if (!gizmo?.children?.length) {
        return null;
      }

      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const edgeTolerance = 2.5;
      let best = null;
      const projectVertex = (position, index, matrixWorld) => {
        const projected = new THREE.Vector3()
          .fromBufferAttribute(position, index)
          .applyMatrix4(matrixWorld)
          .project(this.camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)) {
          return null;
        }
        return {
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height,
          z: projected.z
        };
      };
      const signedArea = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
      const distanceToSegment = (point, a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq <= 0.0001) {
          return Math.hypot(point.x - a.x, point.y - a.y);
        }
        const t = THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
        return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
      };
      const triangleHitScore = (point, a, b, c) => {
        if (Math.abs(signedArea(a, b, c)) < 0.01) {
          return null;
        }
        const d1 = signedArea(point, a, b);
        const d2 = signedArea(point, b, c);
        const d3 = signedArea(point, c, a);
        const inside = !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0);
        if (inside) {
          return 0;
        }
        const edgeDistance = Math.min(
          distanceToSegment(point, a, b),
          distanceToSegment(point, b, c),
          distanceToSegment(point, c, a)
        );
        return edgeDistance <= edgeTolerance ? edgeDistance : null;
      };
      const testTriangle = (axis, position, matrixWorld, aIndex, bIndex, cIndex) => {
        const a = projectVertex(position, aIndex, matrixWorld);
        const b = projectVertex(position, bIndex, matrixWorld);
        const c = projectVertex(position, cIndex, matrixWorld);
        if (!a || !b || !c) {
          return;
        }
        const hitScore = triangleHitScore(pointer, a, b, c);
        if (hitScore === null) {
          return;
        }
        const depthScore = (a.z + b.z + c.z) / 3;
        const score = hitScore * 0.001 + depthScore;
        if (!best || score < best.score) {
          best = { axis, score };
        }
      };

      for (const handle of gizmo.children) {
        if (!["X", "Y", "Z"].includes(handle.name) || handle.visible === false || !handle.geometry?.attributes?.position) {
          continue;
        }
        const position = handle.geometry.attributes.position;
        const index = handle.geometry.index;
        if (index) {
          for (let i = 0; i + 2 < index.count; i += 3) {
            testTriangle(handle.name, position, handle.matrixWorld, index.getX(i), index.getX(i + 1), index.getX(i + 2));
          }
        } else {
          for (let i = 0; i + 2 < position.count; i += 3) {
            testTriangle(handle.name, position, handle.matrixWorld, i, i + 1, i + 2);
          }
        }
      }
      return best;
    },

    updateProjectedTransformGizmoAxis(event) {
      const controls = this.transformControls;
      if (!controls?.enabled || controls.dragging) {
        return false;
      }
      const hit = this.transformControlProjectedAxisHit(event);
      if (!hit?.axis) {
        return false;
      }
      controls.axis = hit.axis;
      this.transformHelper?.updateMatrixWorld?.(true);
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      return true;
    },

    tryProjectedTransformGizmoPointerDown(event) {
      if (event.button !== 0) {
        return false;
      }
      const controls = this.transformControls;
      if (!controls?.enabled || !controls.object || controls.dragging) {
        return false;
      }
      const hit = this.transformControlProjectedAxisHit(event);
      if (!hit?.axis) {
        return false;
      }
      const pointer = this.transformPointerFromEvent(event);
      if (!pointer) {
        return false;
      }
      controls.axis = hit.axis;
      this.transformHelper?.updateMatrixWorld?.(true);
      if (!document.pointerLockElement) {
        try {
          this.canvas.setPointerCapture?.(event.pointerId);
        } catch (error) {
          // Pointer capture can fail if the pointer was already released by the browser.
        }
      }
      if (typeof controls._onPointerMove === "function") {
        this.canvas.addEventListener("pointermove", controls._onPointerMove);
      }
      controls.pointerDown(pointer);
      if (controls.dragging) {
        event.preventDefault();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        return true;
      }
      return false;
    },

    currentOrbitViewSetting() {
      if (!this.camera || !this.controls) {
        return null;
      }
      return {
        version: 1,
        actorId: this.actorTarget?.id || "",
        actionId: this.activeClipEntry?.id || this.activeClipEntry?.name || "",
        cameraPosition: this.camera.position.toArray(),
        cameraUp: this.camera.up.toArray(),
        target: this.controls.target.toArray(),
        zoom: this.camera.zoom,
        fov: this.camera.fov
      };
    },

    savedOrbitViewSetting() {
      if (typeof window === "undefined") {
        return null;
      }
      try {
        const text = window.localStorage?.getItem(ORBIT_VIEW_STORAGE_KEY);
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },

    updateOrbitViewControls() {
      if (this.restoreOrbitViewButton) {
        this.restoreOrbitViewButton.disabled = !this.savedOrbitViewSetting();
      }
      this.updateCameraConfigurationControls?.();
    },

    saveOrbitViewSetting() {
      const view = this.currentOrbitViewSetting();
      if (!view || typeof window === "undefined") {
        this.setStatus("No orbit view to save");
        return false;
      }
      try {
        window.localStorage?.setItem(ORBIT_VIEW_STORAGE_KEY, JSON.stringify(view));
        this.updateOrbitViewControls();
        this.setStatus("Saved orbit view");
        return true;
      } catch {
        this.setStatus("Could not save orbit view");
        return false;
      }
    },

    applyOrbitViewSetting(view = this.savedOrbitViewSetting(), options = {}) {
      if (
        !view
        || !this.camera
        || !this.controls
        || !finiteVectorArray(view.cameraPosition)
        || !finiteVectorArray(view.cameraUp)
        || !finiteVectorArray(view.target)
      ) {
        if (options.status !== false) {
          this.setStatus("No saved orbit view");
        }
        return false;
      }
      this.camera.position.fromArray(view.cameraPosition.map(Number));
      this.camera.up.fromArray(view.cameraUp.map(Number)).normalize();
      this.controls.target.fromArray(view.target.map(Number));
      if (Number.isFinite(Number(view.zoom))) {
        this.camera.zoom = Number(view.zoom);
      }
      if (Number.isFinite(Number(view.fov))) {
        this.camera.fov = Number(view.fov);
      }
      this.camera.lookAt(this.controls.target);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.updateCameraRelativeLights();
      if (options.status !== false) {
        this.setStatus("Restored orbit view");
      }
      return true;
    },

    restoreSavedOrbitView(options = {}) {
      return this.applyOrbitViewSetting(this.savedOrbitViewSetting(), options);
    },

    defaultCameraConfigurationSetting() {
      return {
        backgroundColor: "#11171c",
        meshColor: "#80d8ff",
        ambient: 0.75,
        key: 1.25,
        rim: 0.35,
        texture: 1
      };
    },

    currentCameraConfigurationSetting() {
      const fallback = this.defaultCameraConfigurationSetting();
      const numberValue = (input, fallbackValue) => {
        const value = Number(input?.value);
        return Number.isFinite(value) ? value : fallbackValue;
      };
      return {
        backgroundColor: this.backgroundColor || this.cameraBackgroundColor?.value || fallback.backgroundColor,
        meshColor: this.meshColor || this.cameraMeshColor?.value || fallback.meshColor,
        ambient: numberValue(this.cameraAmbientLight, fallback.ambient),
        key: numberValue(this.cameraKeyLight, fallback.key),
        rim: numberValue(this.cameraRimLight, fallback.rim),
        texture: numberValue(this.cameraTextureGain, fallback.texture)
      };
    },

    savedCameraConfigurationSetting() {
      if (typeof window === "undefined") {
        return null;
      }
      try {
        const text = window.localStorage?.getItem(CAMERA_CONFIGURATION_STORAGE_KEY);
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },

    updateCameraConfigurationControls() {
      if (this.resetCameraSettingsButton) {
        this.resetCameraSettingsButton.disabled = !this.savedCameraConfigurationSetting();
      }
    },

    saveCameraConfigurationSetting() {
      const setting = this.currentCameraConfigurationSetting();
      if (!setting || typeof window === "undefined") {
        this.setStatus("No configuration to save");
        return false;
      }
      try {
        window.localStorage?.setItem(CAMERA_CONFIGURATION_STORAGE_KEY, JSON.stringify(setting));
        this.updateCameraConfigurationControls();
        this.setStatus("Saved configuration");
        return true;
      } catch {
        this.setStatus("Could not save configuration");
        return false;
      }
    },

    applyCameraConfigurationSetting(setting = this.savedCameraConfigurationSetting(), options = {}) {
      if (!setting || typeof setting !== "object") {
        if (options.status !== false) {
          this.setStatus("No saved configuration");
        }
        return false;
      }
      const fallback = this.defaultCameraConfigurationSetting();
      const colorValue = (value, fallbackValue) => (
        /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallbackValue
      );
      const numberValue = (value, fallbackValue) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallbackValue;
      };
      if (this.cameraAmbientLight) {
        this.cameraAmbientLight.value = String(numberValue(setting.ambient, fallback.ambient));
      }
      if (this.cameraKeyLight) {
        this.cameraKeyLight.value = String(numberValue(setting.key, fallback.key));
      }
      if (this.cameraRimLight) {
        this.cameraRimLight.value = String(numberValue(setting.rim, fallback.rim));
      }
      if (this.cameraTextureGain) {
        this.cameraTextureGain.value = String(numberValue(setting.texture, fallback.texture));
      }
      this.applyBackgroundColor(colorValue(setting.backgroundColor, fallback.backgroundColor));
      this.applyMeshColor(colorValue(setting.meshColor, fallback.meshColor));
      this.applySceneLighting();
      this.updateCameraConfigurationControls();
      if (options.status !== false) {
        this.setStatus("Restored configuration");
      }
      return true;
    },

    resetCameraConfigurationSetting(options = {}) {
      return this.applyCameraConfigurationSetting(this.savedCameraConfigurationSetting(), options);
    },

    panelSectionTitle(section) {
      return section?.querySelector?.(".viewer-label")?.textContent?.trim() || "Panel";
    },

    bindPanelSectionCollapseControls() {
      if (this.panelSectionCollapseControlsBound) {
        return;
      }
      this.panelSectionCollapseControlsBound = true;
      const sections = Array.from(document.querySelectorAll(".viewer-panel .viewer-section"));
      for (const section of sections) {
        const title = this.panelSectionTitle(section);
        const label = section.querySelector(":scope > .viewer-label");
        let heading = section.querySelector(":scope > .panel-section-heading, :scope > .rig-bone-heading");
        if (!heading && label) {
          heading = document.createElement("div");
          heading.className = "panel-section-heading";
          section.insertBefore(heading, label);
          heading.append(label);
        }
        if (!heading) {
          continue;
        }
        heading.classList.add("panel-section-heading");
        let button = heading.querySelector(":scope > .panel-section-toggle");
        if (!button && section === this.rigPanel && this.rigPanelToggle) {
          button = this.rigPanelToggle;
        }
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          heading.append(button);
        }
        button.textContent = "";
        button.classList.add("panel-section-toggle");
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-label", `Minimize ${title}`);
        button.title = `Minimize ${title}`;
        if (button.dataset.panelSectionToggleBound === "true") {
          continue;
        }
        button.dataset.panelSectionToggleBound = "true";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.setPanelSectionOpen(section, section.classList.contains("is-panel-section-collapsed"));
        });
      }
    },

    setPanelSectionOpen(section, open) {
      if (!section) {
        return;
      }
      const title = this.panelSectionTitle(section);
      section.classList.toggle("is-panel-section-collapsed", !open);
      if (section === this.rigPanel) {
        section.classList.toggle("is-collapsed", !open);
      }
      const button = section.querySelector(":scope > .panel-section-heading > .panel-section-toggle")
        || (section === this.rigPanel ? this.rigPanelToggle : null);
      if (!button) {
        return;
      }
      button.textContent = "";
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", `${open ? "Minimize" : "Restore"} ${title}`);
      button.title = `${open ? "Minimize" : "Restore"} ${title}`;
    },

    tutorialCardNodes() {
      return Array.from(this.tutorialDrawer?.querySelectorAll(".tutorial-card") || []);
    },

    tutorialRecipesFromDom() {
      return this.tutorialCardNodes().map((card) => ({
        title: card.querySelector(":scope > h3")?.textContent?.trim() || "Recipe",
        targets: card.dataset.tutorialTargets || "",
        steps: Array.from(card.querySelectorAll(":scope > ol > li")).map((step) => ({
          text: tutorialMarkdownFromNode(step),
          targets: step.dataset.tutorialTargets || "",
          action: step.dataset.tutorialAction || "",
          macro: step.dataset.tutorialMacro || ""
        }))
      }));
    },

    tutorialEditorEnabledForBrowser() {
      const params = new URLSearchParams(window.location.search || "");
      const requested = params.get("tutorial-edit") || params.get("tutorialEdit");
      if (/^(1|true|yes)$/i.test(requested || "")) {
        tutorialLocalStorageSet(TUTORIAL_EDITOR_STORAGE_KEY, "1");
        return true;
      }
      if (/^(0|false|no)$/i.test(requested || "")) {
        tutorialLocalStorageRemove(TUTORIAL_EDITOR_STORAGE_KEY);
        return false;
      }
      return tutorialLocalStorageGet(TUTORIAL_EDITOR_STORAGE_KEY) === "1";
    },

    storedTutorialRecipes() {
      if (this.tutorialRecipePackagedCache) {
        return this.tutorialRecipePackagedCache;
      }
      const raw = tutorialLocalStorageGet(TUTORIAL_RECIPES_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        const cards = Array.isArray(parsed) ? parsed : parsed?.cards;
        if (!Array.isArray(cards)) {
          return null;
        }
        return normalizeTutorialRecipeMacros(cards.map((card, index) => normalizedTutorialCard(card, this.tutorialDefaultRecipes?.[index])));
      } catch {
        return null;
      }
    },

    async loadPackagedTutorialRecipes() {
      if (this.tutorialRecipePackagedLoaded) {
        return this.tutorialRecipePackagedCache || null;
      }
      this.tutorialRecipePackagedLoaded = true;
      try {
        const response = await fetch(TUTORIAL_RECIPES_ASSET_URL, { cache: "no-store" });
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        const cards = Array.isArray(payload) ? payload : payload?.cards;
        if (!Array.isArray(cards)) {
          return null;
        }
        this.tutorialRecipePackagedCache = normalizeTutorialRecipeMacros(
          cards.map((card, index) => normalizedTutorialCard(card, this.tutorialDefaultRecipes?.[index]))
        );
        return this.tutorialRecipePackagedCache;
      } catch (error) {
        console.warn("Could not load tutorial recipes from disk", error);
        return null;
      }
    },

    async storeTutorialRecipes(cards) {
      const normalizedCards = normalizeTutorialRecipeMacros(
        (cards || []).map((card, index) => normalizedTutorialCard(card, this.tutorialDefaultRecipes?.[index]))
      );
      try {
        const response = await fetch("/api/tutorial-recipes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cards: normalizedCards })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Could not save tutorial recipes to disk");
        }
        this.tutorialRecipePackagedCache = normalizedCards;
        this.tutorialRecipePackagedLoaded = true;
        tutorialLocalStorageRemove(TUTORIAL_RECIPES_STORAGE_KEY);
        return "disk";
      } catch (error) {
        console.warn("Could not save tutorial recipes to disk", error);
      }
      tutorialLocalStorageSet(TUTORIAL_RECIPES_STORAGE_KEY, JSON.stringify({
        version: 1,
        cards: normalizedCards
      }));
      return "browser";
    },

    renderTutorialRecipes(cards = []) {
      const cardNodes = this.tutorialCardNodes();
      for (const [index, cardNode] of cardNodes.entries()) {
        const fallback = this.tutorialDefaultRecipes?.[index] || {};
        const card = normalizeTutorialRecipeMacros([normalizedTutorialCard(cards[index], fallback)])[0];
        const title = cardNode.querySelector(":scope > h3");
        const list = cardNode.querySelector(":scope > ol");
        if (title) {
          title.textContent = card.title;
        }
        if (card.targets) {
          cardNode.dataset.tutorialTargets = card.targets;
        }
        if (!list) {
          continue;
        }
        list.replaceChildren(...card.steps.map((step) => {
          const item = document.createElement("li");
          if (step.targets) {
            item.dataset.tutorialTargets = step.targets;
          }
          if (step.action) {
            item.dataset.tutorialAction = step.action;
          }
          if (step.macro) {
            item.dataset.tutorialMacro = step.macro;
          }
          appendTutorialMarkdown(item, step.text);
          return item;
        }));
      }
    },

    ensureTutorialCardEditors() {
      for (const card of this.tutorialCardNodes()) {
        if (card.querySelector(":scope > .tutorial-card-editor")) {
          continue;
        }
        const editor = document.createElement("div");
        editor.className = "tutorial-card-editor";
        editor.hidden = true;

        const titleLabel = document.createElement("label");
        const titleLabelText = document.createElement("span");
        const titleInput = document.createElement("input");
        titleLabelText.textContent = "Title";
        titleInput.className = "tutorial-title-input";
        titleInput.type = "text";
        titleInput.autocomplete = "off";
        titleLabel.append(titleLabelText, titleInput);

        const stepsLabel = document.createElement("label");
        const stepsLabelText = document.createElement("span");
        const stepsInput = document.createElement("textarea");
        stepsLabelText.textContent = "Steps";
        stepsInput.className = "tutorial-steps-input";
        stepsInput.rows = 4;
        stepsInput.spellcheck = true;
        stepsLabel.append(stepsLabelText, stepsInput);
        editor.append(titleLabel, stepsLabel);
        card.append(editor);
      }
    },

    populateTutorialEditors(cards = this.tutorialRecipesFromDom()) {
      const cardNodes = this.tutorialCardNodes();
      for (const [index, cardNode] of cardNodes.entries()) {
        const card = normalizedTutorialCard(cards[index], this.tutorialDefaultRecipes?.[index]);
        const titleInput = cardNode.querySelector(":scope .tutorial-title-input");
        const stepsInput = cardNode.querySelector(":scope .tutorial-steps-input");
        if (titleInput) {
          titleInput.value = card.title;
        }
        if (stepsInput) {
          stepsInput.value = card.steps.map((step) => step.text).join("\n");
        }
      }
    },

    tutorialRecipesFromEditors() {
      const previousCards = this.tutorialEditSnapshot || this.tutorialRecipesFromDom();
      return normalizeTutorialRecipeMacros(this.tutorialCardNodes().map((cardNode, cardIndex) => {
        const fallback = normalizedTutorialCard(previousCards[cardIndex], this.tutorialDefaultRecipes?.[cardIndex]);
        const title = cardNode.querySelector(":scope .tutorial-title-input")?.value?.trim() || fallback.title;
        const stepLines = (cardNode.querySelector(":scope .tutorial-steps-input")?.value || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          title,
          targets: fallback.targets,
          steps: stepLines.map((line, stepIndex) => ({
            text: line,
            targets: fallback.steps[stepIndex]?.targets || fallback.targets,
            action: fallback.steps[stepIndex]?.action || "",
            macro: fallback.steps[stepIndex]?.macro || ""
          }))
        };
      }));
    },

    updateTutorialEditControls() {
      const enabled = Boolean(this.tutorialEditorEnabled);
      const editing = Boolean(this.tutorialEditing);
      if (this.tutorialEditButton) {
        this.tutorialEditButton.hidden = !enabled || editing;
      }
      if (this.tutorialSaveButton) {
        this.tutorialSaveButton.hidden = !enabled || !editing;
      }
      if (this.tutorialCancelButton) {
        this.tutorialCancelButton.hidden = !enabled || !editing;
      }
      if (this.tutorialResetButton) {
        this.tutorialResetButton.hidden = !enabled;
      }
      this.updateTutorialMacroControls?.();
    },

    setTutorialEditing(editing) {
      if (!this.tutorialEditorEnabled || !this.tutorialDrawer) {
        return;
      }
      const nextEditing = Boolean(editing);
      this.tutorialEditing = nextEditing;
      this.tutorialDrawer.classList.toggle("is-editing", nextEditing);
      if (nextEditing) {
        this.clearTutorialHighlights?.();
        this.ensureTutorialCardEditors();
        this.tutorialEditSnapshot = this.tutorialRecipesFromDom();
        this.populateTutorialEditors(this.tutorialEditSnapshot);
      }
      for (const card of this.tutorialCardNodes()) {
        card.classList.toggle("is-editing", nextEditing);
        const editor = card.querySelector(":scope > .tutorial-card-editor");
        if (editor) {
          editor.hidden = !nextEditing;
        }
      }
      this.updateTutorialEditControls();
    },

    async saveTutorialEdits() {
      const cards = this.tutorialRecipesFromEditors();
      this.renderTutorialRecipes(cards);
      const mode = await this.storeTutorialRecipes(cards);
      this.setTutorialEditing(false);
      this.setStatus(mode === "disk" ? "Tutorial recipes saved to disk" : "Tutorial recipes saved in this browser");
    },

    cancelTutorialEdits() {
      if (this.tutorialEditSnapshot) {
        this.renderTutorialRecipes(this.tutorialEditSnapshot);
      }
      this.setTutorialEditing(false);
      this.setStatus("Tutorial edits canceled");
    },

    async resetTutorialRecipes() {
      tutorialLocalStorageRemove(TUTORIAL_RECIPES_STORAGE_KEY);
      const cards = this.tutorialDefaultRecipes || [];
      this.renderTutorialRecipes(cards);
      await this.storeTutorialRecipes(cards);
      this.setTutorialEditing(false);
      this.setStatus("Tutorial recipes reset");
    },

    initializeTutorialEditor() {
      if (!this.tutorialDrawer || this.tutorialEditorInitialized) {
        return;
      }
      this.tutorialEditorInitialized = true;
      this.tutorialDefaultRecipes = this.tutorialRecipesFromDom();
      this.tutorialEditorEnabled = this.tutorialEditorEnabledForBrowser();
      const storedRecipes = this.storedTutorialRecipes();
      if (storedRecipes) {
        this.renderTutorialRecipes(storedRecipes);
      }
      void this.loadPackagedTutorialRecipes?.().then((recipes) => {
        if (recipes) {
          this.renderTutorialRecipes(recipes);
        }
      });
      this.bindTutorialMacroControls?.();
      this.updateTutorialEditControls();
    },

    clearTutorialHighlights() {
      for (const element of this.tutorialHighlightedElements || []) {
        element.classList.remove("tutorial-highlight-target");
      }
      for (const node of this.tutorialDrawer?.querySelectorAll(".tutorial-card.is-active, .tutorial-card li.is-active") || []) {
        node.classList.remove("is-active");
      }
      this.tutorialBackdrop?.classList.remove("is-highlight-mode");
      this.tutorialHighlightedElements = [];
      this.tutorialActiveMacroName = "";
      this.updateTutorialMacroControls?.();
    },

    highlightTutorialTargets(source) {
      if (!source || this.tutorialEditing) {
        return;
      }
      const card = source.closest(".tutorial-card");
      const targetText = source.dataset.tutorialTargets || card?.dataset.tutorialTargets || "";
      const macroName = source.dataset.tutorialMacro || "";
      const selectors = targetText.split(",").map((selector) => selector.trim()).filter(Boolean);
      this.clearTutorialHighlights();
      this.tutorialActiveMacroName = macroName;
      if (macroName) {
        this.attachTutorialDemoControls?.(source);
      }
      this.updateTutorialMacroControls?.();
      card?.classList.add("is-active");
      source.classList.add("is-active");

      const targets = [];
      for (const selector of selectors) {
        for (const target of document.querySelectorAll(selector)) {
          if (this.tutorialDrawer?.contains(target)) {
            continue;
          }
          if (!targets.includes(target)) {
            targets.push(target);
          }
        }
      }
      for (const target of targets) {
        const section = target.closest(".viewer-section");
        if (section) {
          this.setPanelSectionOpen?.(section, true);
        }
        target.classList.add("tutorial-highlight-target");
      }
      this.tutorialHighlightedElements = targets;
      this.tutorialBackdrop?.classList.toggle("is-highlight-mode", targets.length > 0);
      const firstVisibleTarget = targets.find((target) => {
        const rect = target.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      firstVisibleTarget?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
      if (targets.length) {
        this.setStatus(`Highlighted ${targets.length} tutorial ${targets.length === 1 ? "area" : "areas"}`);
      }
    },

    handleTutorialRecipeClick(event) {
      if (this.tutorialEditing || event.target?.closest?.(".tutorial-card-editor")) {
        return;
      }
      const source = event.target?.closest?.(".tutorial-card li[data-tutorial-targets], .tutorial-card");
      if (!source || !this.tutorialDrawer?.contains(source)) {
        return;
      }
      this.highlightTutorialTargets(source);
      void this.runTutorialAction(source);
    },

    async runTutorialAction(source) {
      const action = source?.dataset?.tutorialAction || "";
      if (action === "fill-demo-folder-name") {
        if (this.tutorialDemoAnimationLibraryName?.() !== "cat") {
          return false;
        }
        const label = this.tutorialDemoFolderLabel?.("cat") || "Cat Demo";
        if (this.animationLibraryFolderName) {
          this.animationLibraryFolderName.value = label;
          this.animationLibraryFolderName.focus();
          this.animationLibraryFolderName.select?.();
        }
        this.setStatus(`Entered folder name ${label}`);
        return true;
      }
      if (action === "create-demo-folder") {
        if (this.tutorialDemoAnimationLibraryName?.() !== "cat") {
          return false;
        }
        return await this.createAnimationLibraryFolder?.(this.tutorialDemoFolderLabel?.("cat") || "Cat Demo") || false;
      }
      if (action === "seed-demo-cat") {
        return this.seedTutorialDemoAnimationLibraryFile?.("cat") || false;
      }
      if (action === "load-demo-cat") {
        return await this.ensureTutorialDemoModelLoaded?.("cat") || false;
      }
      if (action === "ensure-demo-fk-ik-chain") {
        const loaded = await this.ensureTutorialDemoModelLoaded?.("cat") || false;
        if (!loaded) {
          return false;
        }
        return Boolean(this.ensureTutorialDemoFkIkChain?.({ status: true }));
      }
      const macroName = source?.dataset?.tutorialMacro || "";
      if (macroName) {
        const loaded = await this.ensureTutorialDemoModelLoaded?.("cat") || false;
        if (!loaded) {
          return false;
        }
        if (macroName === "fk-ik") {
          this.ensureTutorialDemoFkIkChain?.({ status: false });
        }
        this.highlightTutorialTargets(source);
        this.setStatus("Demo ready");
        return true;
      }
      if (!this.tutorialSourceNeedsDemoModel?.(source)) {
        return false;
      }
      const loaded = await this.ensureTutorialDemoModelLoaded?.("cat") || false;
      if (loaded) {
        this.highlightTutorialTargets(source);
      }
      return loaded;
    },

    tutorialSourceNeedsDemoModel(source) {
      if (this.tutorialDemoAnimationLibraryName?.() !== "cat" || !source) {
        return false;
      }
      const action = source.dataset?.tutorialAction || "";
      if (["fill-demo-folder-name", "create-demo-folder", "seed-demo-cat"].includes(action)) {
        return false;
      }
      const card = source.closest?.(".tutorial-card");
      const cards = this.tutorialCardNodes?.() || [];
      const quickStart = cards[0] || null;
      if (!card) {
        return false;
      }
      if (card === quickStart) {
        if (!source.matches?.("li")) {
          return false;
        }
        const steps = Array.from(card.querySelectorAll(":scope > ol > li"));
        return steps.indexOf(source) >= 3;
      }
      return cards.indexOf(card) > 0;
    },

    tutorialMacroModeActive() {
      return Boolean(this.tutorialDrawerOpen || this.tutorialSessionActive);
    },

    captureTutorialSessionState() {
      const cloneMap = (map, mapper = (value) => value) => new Map(
        Array.from(map?.entries?.() || [], ([key, value]) => [key, mapper(value, key)])
      );
      const cloneFolder = (folder) => ({
        ...folder,
        files: Array.isArray(folder.files) ? folder.files.map((file) => ({ ...file })) : []
      });
      const cloneChainSetting = (value) => ({ ...value });
      const cloneConstraint = (value) => ({
        ...value,
        min: { ...(value?.min || {}) },
        max: { ...(value?.max || {}) }
      });
      return {
        hasModel: Boolean(this.model),
        actorTarget: this.actorTarget,
        model: this.model,
        modelRootChildren: Array.from(this.modelRoot?.children || []),
        modelRootVisible: this.modelRoot?.visible !== false,
        baseModelScale: this.baseModelScale,
        actorScaleMultiplier: this.actorScaleMultiplier,
        mixer: this.mixer,
        activeClipAction: this.activeClipAction,
        activeClipEntry: this.activeClipEntry,
        blendClipAction: this.blendClipAction,
        blendClipEntry: this.blendClipEntry,
        blendActionId: this.blendActionId,
        clipEntries: Array.isArray(this.clipEntries) ? [...this.clipEntries] : [],
        clipCleanupEdits: cloneMap(this.clipCleanupEdits, (value) => ({ ...value })),
        rootMotionUnbakeActions: cloneMap(this.rootMotionUnbakeActions, (value) => ({ ...value })),
        bindPose: Array.isArray(this.bindPose) ? [...this.bindPose] : [],
        bones: cloneMap(this.bones),
        paintRecords: Array.isArray(this.paintRecords) ? [...this.paintRecords] : [],
        virtualBones: Array.isArray(this.virtualBones) ? [...this.virtualBones] : [],
        manualBoneChains: Array.isArray(this.manualBoneChains) ? this.manualBoneChains.map((chain) => ({ ...chain })) : [],
        ikChainSettings: cloneMap(this.ikChainSettings, cloneChainSetting),
        jointConstraints: cloneMap(this.jointConstraints, cloneConstraint),
        jointConstraintTemplates: this.jointConstraintTemplates ? cloneMap(this.jointConstraintTemplates) : this.jointConstraintTemplates,
        jointConstraintEditedPoseBone: this.jointConstraintEditedPoseBone || "",
        jointConstraintEditedPoseChannels: new Set(this.jointConstraintEditedPoseChannels || []),
        boneLayerNames: Array.isArray(this.boneLayerNames) ? [...this.boneLayerNames] : [],
        bonePickerNames: Array.isArray(this.bonePickerNames) ? [...this.bonePickerNames] : [],
        activeBoneName: this.activeBoneName || "",
        selectedBoneChainRootName: this.selectedBoneChainRootName || "",
        rigBoneGroup: this.rigBoneGroup || "all",
        rigBoneSearchText: this.rigBoneSearchText || "",
        viewMode: this.viewMode || "rendered",
        showRenderedLayer: this.showRenderedLayer !== false,
        showMeshLayer: Boolean(this.showMeshLayer),
        showSelectionLayer: this.showSelectionLayer !== false,
        showBonesLayer: Boolean(this.showBonesLayer),
        cleanPreview: Boolean(this.cleanPreview),
        gizmoOnlyPreview: Boolean(this.gizmoOnlyPreview),
        backgroundColor: this.backgroundColor || "#11171c",
        meshColor: this.meshColor || "#80d8ff",
        activeTool: this.activeTool || "paint",
        progress: Number(this.progress) || 0,
        playing: Boolean(this.playing),
        undoStack: Array.isArray(this.undoStack) ? [...this.undoStack] : [],
        redoStack: Array.isArray(this.redoStack) ? [...this.redoStack] : [],
        animationLibraryFolders: Array.isArray(this.animationLibraryFolders)
          ? this.animationLibraryFolders.map(cloneFolder)
          : [],
        animationLibrarySelectedFolder: this.animationLibrarySelectedFolder || "",
        animationLibraryStorageMode: this.animationLibraryStorageMode || "",
        tutorialDemoLibraryFolderName: this.tutorialDemoLibraryFolderName || "",
        tutorialDemoLibraryImported: Boolean(this.tutorialDemoLibraryImported),
        editorState: this.captureUndoState?.("Tutorial session", { includeClip: true }) || null,
        sourceText: this.source?.textContent || "",
        statusText: this.status?.textContent || "",
        characterSelectValue: this.characterSelect?.value || "",
        actionSelectValue: this.actionSelect?.value || "",
        folderSelectValue: this.animationLibraryFolderSelect?.value || ""
      };
    },

    resetTutorialSessionWorkspace() {
      this.loadToken = (this.loadToken || 0) + 1;
      this.pausePlayback?.();
      this.stopSequencePreview?.({ applyPose: false, resetElapsed: false });
      this.clearActorModel?.();
      this.actorTarget = ACTOR_TARGETS[0];
      this.activeTool = "paint";
      this.viewMode = "rendered";
      this.showRenderedLayer = true;
      this.showMeshLayer = false;
      this.showSelectionLayer = true;
      this.showBonesLayer = false;
      this.cleanPreview = false;
      this.gizmoOnlyPreview = false;
      this.applyBackgroundColor?.("#11171c");
      this.applyMeshColor?.("#80d8ff");
      this.animationLibrarySelectedFolder = this.animationLibraryFolderSelect?.value || this.animationLibrarySelectedFolder || "";
      this.renderCharacterOptions?.();
      this.renderActionOptions?.();
      this.populateBoneSelect?.();
      this.renderBoneChainOptions?.();
      this.renderAddBoneChainMemberOptions?.();
      this.syncTimelineControls?.();
      this.updateTimelineKeyMarkers?.();
      this.syncPatchJson?.();
      this.syncExportButtons?.();
      this.setViewMode?.("rendered", { silent: true });
      if (this.source) {
        this.source.textContent = "Import a raw Mixamo FBX to begin";
      }
      this.setStatus("Tutorial workspace ready");
    },

    beginTutorialSession() {
      if (this.tutorialSessionActive) {
        return false;
      }
      this.tutorialSessionState = this.captureTutorialSessionState();
      this.tutorialSessionActive = true;
      this.resetTutorialSessionWorkspace();
      this.updateTutorialMacroControls?.();
      return true;
    },

    restoreTutorialSessionToolState(state) {
      this.activeTool = state?.activeTool || "paint";
      if (this.controls) {
        this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
      }
      this.toolButtons?.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.tool === this.activeTool);
      });
      this.app?.classList.toggle("is-texture-airbrush", this.activeTool === "airbrush");
      this.canvas?.classList.toggle("is-texture-airbrush", this.activeTool === "airbrush");
      const isSelectionBrush = this.usesSelectionBrushCursor?.(this.activeTool) === true;
      this.app?.classList.toggle("is-selection-brush", isSelectionBrush);
      this.canvas?.classList.toggle("is-selection-brush", isSelectionBrush);
    },

    restoreTutorialSessionChrome(state) {
      this.renderAnimationLibrary?.();
      this.renderCharacterOptions?.();
      this.renderActionOptions?.();
      this.populateBoneSelect?.();
      this.renderBoneChainOptions?.();
      this.renderAddBoneChainMemberOptions?.();
      this.syncScaleControls?.();
      this.syncTimelineControls?.();
      this.updateTimelineKeyMarkers?.();
      this.syncPoseClipboardControls?.();
      this.syncExportButtons?.();
      this.syncPatchJson?.();
      this.updateCounts?.();
      this.updateUndoButton?.();
      this.updateSkeletonHelper?.();
      this.updateSelectionMarkers?.();
      this.updateMoveGizmo?.();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBonePickerOverlay?.();
      this.updateBoneLabels?.();
      if (this.characterSelect && state?.characterSelectValue) {
        this.characterSelect.value = state.characterSelectValue;
      }
      if (this.actionSelect && state?.actionSelectValue) {
        this.actionSelect.value = state.actionSelectValue;
      }
      if (this.animationLibraryFolderSelect && state?.folderSelectValue) {
        this.animationLibraryFolderSelect.value = state.folderSelectValue;
      }
      if (this.source) {
        this.source.textContent = state?.sourceText || this.actorTarget?.sourceLabel || "Import a raw Mixamo FBX to begin";
      }
      this.setStatus(state?.statusText || "Tutorial closed");
    },

    async restoreTutorialSessionState(state) {
      this.pausePlayback?.();
      this.stopSequencePreview?.({ applyPose: false, resetElapsed: false });
      this.loadToken = (this.loadToken || 0) + 1;
      this.clearActorModel?.();
      if (!state) {
        this.actorTarget = ACTOR_TARGETS[0];
        this.renderCharacterOptions?.();
        this.renderActionOptions?.();
        this.setStatus("Tutorial closed");
        return false;
      }
      this.actorTarget = state.actorTarget || ACTOR_TARGETS[0];
      this.animationLibraryFolders = Array.isArray(state.animationLibraryFolders)
        ? state.animationLibraryFolders
        : [];
      this.animationLibrarySelectedFolder = state.animationLibrarySelectedFolder || "";
      this.animationLibraryStorageMode = state.animationLibraryStorageMode || this.animationLibraryStorageMode;
      this.tutorialDemoLibraryFolderName = state.tutorialDemoLibraryFolderName || "";
      this.tutorialDemoLibraryImported = Boolean(state.tutorialDemoLibraryImported);
      if (!state.hasModel || !state.model) {
        this.restoreTutorialSessionToolState(state);
        this.showRenderedLayer = state.showRenderedLayer !== false;
        this.showMeshLayer = Boolean(state.showMeshLayer);
        this.showSelectionLayer = state.showSelectionLayer !== false;
        this.showBonesLayer = Boolean(state.showBonesLayer);
        this.cleanPreview = Boolean(state.cleanPreview);
        this.gizmoOnlyPreview = Boolean(state.gizmoOnlyPreview);
        this.applyBackgroundColor?.(state.backgroundColor || "#11171c");
        this.applyMeshColor?.(state.meshColor || "#80d8ff");
        this.setViewMode?.(state.viewMode || "rendered", { silent: true, preserveViewportLayers: true });
        this.restoreTutorialSessionChrome(state);
        this.setPlayback?.(Boolean(state.playing));
        return true;
      }

      this.model = state.model;
      this.baseModelScale = state.baseModelScale || 1;
      this.actorScaleMultiplier = state.actorScaleMultiplier || 1;
      this.mixer = state.mixer || (this.model ? new THREE.AnimationMixer(this.model) : null);
      this.activeClipAction = state.activeClipAction || null;
      this.activeClipEntry = state.activeClipEntry || null;
      this.blendClipAction = state.blendClipAction || null;
      this.blendClipEntry = state.blendClipEntry || null;
      this.blendActionId = state.blendActionId || "";
      this.clipEntries = Array.isArray(state.clipEntries) ? [...state.clipEntries] : [];
      this.clipCleanupEdits = state.clipCleanupEdits || new Map();
      this.rootMotionUnbakeActions = state.rootMotionUnbakeActions || new Map();
      this.bindPose = Array.isArray(state.bindPose) ? [...state.bindPose] : [];
      this.bones = state.bones || new Map();
      this.paintRecords = Array.isArray(state.paintRecords) ? [...state.paintRecords] : [];
      this.virtualBones = Array.isArray(state.virtualBones) ? [...state.virtualBones] : [];
      this.manualBoneChains = Array.isArray(state.manualBoneChains) ? [...state.manualBoneChains] : [];
      this.ikChainSettings = state.ikChainSettings || new Map();
      this.jointConstraints = state.jointConstraints || new Map();
      this.jointConstraintTemplates = state.jointConstraintTemplates || this.jointConstraintTemplates;
      this.jointConstraintEditedPoseBone = state.jointConstraintEditedPoseBone || "";
      this.jointConstraintEditedPoseChannels = state.jointConstraintEditedPoseChannels || new Set();
      this.boneLayerNames = Array.isArray(state.boneLayerNames) ? [...state.boneLayerNames] : [];
      this.bonePickerNames = Array.isArray(state.bonePickerNames) ? [...state.bonePickerNames] : [];
      this.activeBoneName = state.activeBoneName || "";
      this.selectedBoneChainRootName = state.selectedBoneChainRootName || "";
      this.rigBoneGroup = state.rigBoneGroup || "all";
      this.rigBoneSearchText = state.rigBoneSearchText || "";
      this.progress = THREE.MathUtils.clamp(Number(state.progress) || 0, 0, 1);
      this.showRenderedLayer = state.showRenderedLayer !== false;
      this.showMeshLayer = Boolean(state.showMeshLayer);
      this.showSelectionLayer = state.showSelectionLayer !== false;
      this.showBonesLayer = Boolean(state.showBonesLayer);
      this.cleanPreview = Boolean(state.cleanPreview);
      this.gizmoOnlyPreview = Boolean(state.gizmoOnlyPreview);
      this.applyBackgroundColor?.(state.backgroundColor || "#11171c");
      this.applyMeshColor?.(state.meshColor || "#80d8ff");
      this.undoStack = Array.isArray(state.undoStack) ? [...state.undoStack] : [];
      this.redoStack = Array.isArray(state.redoStack) ? [...state.redoStack] : [];

      this.modelRoot?.clear();
      const children = state.modelRootChildren?.length ? state.modelRootChildren : [state.model];
      for (const child of children) {
        if (child) {
          this.modelRoot?.add(child);
        }
      }
      if (this.modelRoot) {
        this.modelRoot.visible = state.modelRootVisible !== false;
      }

      this.restoreTutorialSessionToolState(state);
      this.setViewMode?.(state.viewMode || "rendered", { silent: true, preserveViewportLayers: true });
      if (state.editorState) {
        this.restoreEditorState?.(state.editorState, "Restored");
      } else if (this.activeClipEntry) {
        await this.playClipEntry?.(this.activeClipEntry);
      } else {
        this.applyPose?.(this.progress);
      }
      this.restoreTutorialSessionChrome(state);
      this.setPlayback?.(Boolean(state.playing));
      return true;
    },

    async endTutorialSession() {
      if (!this.tutorialSessionActive && !this.tutorialSessionState) {
        this.updateTutorialMacroControls?.();
        return false;
      }
      const state = this.tutorialSessionState;
      this.tutorialSessionActive = false;
      this.tutorialSessionState = null;
      if (this.tutorialMacroRecording) {
        await this.stopTutorialMacroRecording?.();
      }
      if (this.tutorialMacroPlaying) {
        this.stopTutorialMacroPlayback?.();
      }
      const restored = await this.restoreTutorialSessionState(state);
      this.updateTutorialMacroControls?.();
      return restored;
    },

    queueTutorialViewportResize() {
      if (!this.canvas || typeof window === "undefined") {
        return;
      }
      window.clearTimeout(this.tutorialDrawerResizeTimer);
      window.requestAnimationFrame(() => {
        this.resize();
        window.requestAnimationFrame(() => this.resize());
      });
      this.tutorialDrawerResizeTimer = window.setTimeout(() => this.resize(), 220);
    },

    setTutorialDrawerOpen(open) {
      if (!this.tutorialDrawer) {
        return;
      }
      const nextOpen = Boolean(open);
      window.clearTimeout(this.tutorialDrawerHideTimer);
      this.tutorialDrawerOpen = nextOpen;
      this.app?.classList.toggle("is-tutorial-drawer-open", nextOpen);
      this.queueTutorialViewportResize();
      this.tutorialsToggle?.setAttribute("aria-expanded", String(nextOpen));
      this.tutorialDrawer.setAttribute("aria-hidden", String(!nextOpen));
      if (nextOpen) {
        this.beginTutorialSession?.();
        this.tutorialDrawer.hidden = false;
        if (this.tutorialBackdrop) {
          this.tutorialBackdrop.hidden = false;
        }
        window.requestAnimationFrame(() => {
          if (!this.tutorialDrawerOpen) {
            return;
          }
          this.tutorialDrawer?.classList.add("is-open");
          this.tutorialBackdrop?.classList.add("is-open");
        });
        this.tutorialCloseButton?.focus({ preventScroll: true });
        return;
      }
      this.clearTutorialHighlights?.();
      void this.endTutorialSession?.();
      this.tutorialDrawer.classList.remove("is-open");
      this.tutorialBackdrop?.classList.remove("is-open", "is-macro-recording");
      this.queueTutorialViewportResize();
      this.tutorialDrawerHideTimer = window.setTimeout(() => {
        this.tutorialDrawer.hidden = true;
        if (this.tutorialBackdrop) {
          this.tutorialBackdrop.hidden = true;
        }
      }, 180);
      this.tutorialsToggle?.focus({ preventScroll: true });
    },

    bindControls() {
      this.bindPanelSectionCollapseControls?.();
      this.initializeTutorialEditor?.();
      this.characterSelect?.addEventListener("change", () => {
        void this.selectActor(this.characterSelect.value);
      });
      this.actionSelect?.addEventListener("change", () => {
        if (this.selectedLibraryCharacterFolderName?.()) {
          void this.loadSelectedAnimationLibraryFile?.();
          return;
        }
        void this.selectClipAction(this.actionSelect.value);
      });
      this.exportFbxButton?.addEventListener("click", () => {
        void this.exportFbxAsset?.();
      });
      this.fbxExportTargetSelect?.addEventListener("change", () => {
        this.setFbxExportTarget?.(this.fbxExportTargetSelect.value);
      });
      this.exportGlbButton?.addEventListener("click", () => {
        void this.exportGlbAsset?.();
      });
      this.unbakeRootMotionButton?.addEventListener("click", () => {
        this.withUndo("Unbake root motion", () => this.unbakeActiveClipHipRootMotion?.(), { includeClip: true });
      });
      this.bindAnimationLibraryControls?.();
      this.timelineBlendActionSelect?.addEventListener("change", () => {
        void this.selectBlendAction(this.timelineBlendActionSelect.value);
      });
      this.transferCleanupToBlendButton?.addEventListener("click", () => {
        void this.transferCleanupToBlendAction?.();
      });
      this.rigBoneSearch?.addEventListener("input", () => {
        this.rigBoneSearchText = this.rigBoneSearch.value.trim().toLowerCase();
        this.updateRigBoneList();
      });
      this.rigBoneGroups?.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-rig-bone-group]");
        if (!button) {
          return;
        }
        this.rigBoneGroup = button.dataset.rigBoneGroup || "all";
        this.updateRigBoneList();
      });
      this.addBoneButton?.addEventListener("click", () => this.withRigUndo("Add bone", () => this.addBoneFromControls()));
      this.addBoneChainButton?.addEventListener("click", () => this.withRigUndo("Add chain", () => this.addBoneChainFromControls()));
      this.addBoneChainMembersSelect?.addEventListener("mousedown", (event) => {
        const option = event.target instanceof HTMLOptionElement ? event.target : null;
        if (!option || !(event.ctrlKey || event.metaKey) || !option.selected) {
          return;
        }
        event.preventDefault();
        option.selected = false;
        this.addBoneChainMembersSelect.focus();
        this.syncSelectedBoneChainFromMemberSelect?.();
      });
      this.addBoneChainMembersSelect?.addEventListener("contextmenu", (event) => {
        if (event.target instanceof HTMLOptionElement && event.ctrlKey) {
          event.preventDefault();
        }
      });
      this.addBoneChainMembersSelect?.addEventListener("change", () => {
        this.syncSelectedBoneChainFromMemberSelect?.();
      });
      this.placeBoneSelectionButton?.addEventListener("click", () => this.beginBonePlacement());
      this.addBoneParentSelect?.addEventListener("change", () => {
        if (this.customBoneRecord?.(this.activeBoneName)) {
          this.withUndo("Update bone", () => this.updateActiveVirtualBoneFromInspector?.());
          return;
        }
        this.setActiveBone(this.addBoneParentSelect.value);
      });
      this.updateBoneButton?.addEventListener("click", () => {
        const updated = this.withUndo("Update bone", () => this.updateActiveVirtualBoneFromInspector?.());
        if (updated) {
          this.showActiveBoneMoveGizmo?.();
        } else {
          this.setStatus("Select a custom bone to move");
        }
      });
      const rigNumberInputs = [
        this.addBonePosX,
        this.addBonePosY,
        this.addBonePosZ,
        this.addBoneRotX,
        this.addBoneRotY,
        this.addBoneRotZ
      ].filter(Boolean);
      const beginRigInspectorUndo = () => {
        if (this.customBoneRecord?.(this.activeBoneName)) {
          this.beginPoseControlUndo("Update bone");
        }
      };
      const updateRigInspector = (status = false) => {
        const updated = this.updateActiveVirtualBoneFromInspector?.({ status });
        if (updated) {
          this.updateBoneMoveGizmo?.();
        }
      };
      for (const input of rigNumberInputs) {
        input.addEventListener("pointerdown", beginRigInspectorUndo);
        input.addEventListener("focus", beginRigInspectorUndo);
        input.addEventListener("input", () => updateRigInspector(false));
        input.addEventListener("change", () => updateRigInspector(true));
        input.addEventListener("blur", () => this.endPoseControlUndo());
      }
      this.addBoneNameInput?.addEventListener("focus", beginRigInspectorUndo);
      this.addBoneNameInput?.addEventListener("change", () => updateRigInspector(true));
      this.addBoneNameInput?.addEventListener("blur", () => {
        updateRigInspector(true);
        this.endPoseControlUndo();
      });
      this.deleteBoneButton?.addEventListener("click", () => this.withUndo("Delete bone", () => this.deleteActiveVirtualBone()));
      this.boneGizmoButton?.addEventListener("click", () => this.toggleActiveBoneMoveGizmo?.());
      this.ikGizmoButton?.addEventListener("click", () => this.toggleIkMoveGizmo?.());
      for (const input of this.fkGizmoModeInputs || []) {
        input.addEventListener("change", () => {
          if (input.checked) {
            this.setFkGizmoMode?.(input.value);
          }
        });
      }
      this.ikSolverModeSelect?.addEventListener("change", () => {
        this.withUndo("IK settings", () => this.updateSelectedIkSettingsFromControls?.());
      });
      this.ikCounterRotation?.addEventListener("input", () => {
        if (this.ikCounterRotationOutput) {
          this.ikCounterRotationOutput.textContent = (Number(this.ikCounterRotation.value) || 0).toFixed(2);
        }
      });
      this.ikCounterRotation?.addEventListener("change", () => {
        this.withUndo("IK settings", () => this.updateSelectedIkSettingsFromControls?.());
      });
      this.convertAdaptiveKeyButton?.addEventListener("click", () => {
        const frame = this.currentAdaptiveConvertFrame;
        if (!Number.isInteger(frame)) {
          return;
        }
        const convert = () => this.convertAdaptiveMarkerToKeyframe?.(frame);
        if (typeof this.withUndo === "function") {
          this.withUndo("Convert adaptive key", convert);
        } else {
          convert();
        }
        this.syncAdaptiveConvertButton?.();
      });
      this.jointConstraintEnabled?.addEventListener("change", () => {
        this.withUndo("Joint constraint", () => this.updateSelectedJointConstraintFromControls?.());
      });
      for (const input of [
        this.jointConstraintXMin,
        this.jointConstraintXMax,
        this.jointConstraintYMin,
        this.jointConstraintYMax,
        this.jointConstraintZMin,
        this.jointConstraintZMax
      ].filter(Boolean)) {
        input.addEventListener("change", () => {
          this.withUndo("Joint constraint", () => this.updateSelectedJointConstraintFromControls?.());
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            input.blur();
          }
        });
      }
      this.jointConstraintClearButton?.addEventListener("click", () => {
        this.withUndo("Clear joint constraint", () => this.clearSelectedJointConstraint?.());
      });
      for (const button of this.jointConstraintCaptureButtons || []) {
        button.addEventListener("click", () => {
          this.withUndo("Capture joint limit", () => {
            this.captureCurrentJointConstraintPoseLimit?.(button.dataset.jointConstraintCapture || "max");
          });
        });
      }
      this.jointConstraintSaveTemplateButton?.addEventListener("click", () => this.saveCurrentJointConstraintTemplate?.());
      this.jointConstraintApplyTemplateButton?.addEventListener("click", () => {
        this.withUndo("Apply joint constraints", () => this.applySelectedJointConstraintTemplate?.());
      });
      this.jointConstraintDeleteTemplateButton?.addEventListener("click", () => this.deleteSelectedJointConstraintTemplate?.());
      this.refreshJointConstraintTemplateSelect?.();
      this.syncJointConstraintControls?.();

      this.viewModeButtons.forEach((button) => {
        button.addEventListener("click", () => this.setViewMode(button.dataset.viewMode));
      });
      this.viewportLayerButtons?.forEach((button) => {
        button.addEventListener("click", () => this.toggleViewportLayer(button.dataset.viewportLayer));
      });
      this.cleanPreviewButton.addEventListener("click", () => this.setCleanPreview(!this.cleanPreview));
      this.gizmoOnlyPreviewButton?.addEventListener("click", () => this.setGizmoOnlyPreview(!this.gizmoOnlyPreview));
      this.mirrorModeButton?.addEventListener("click", () => this.setMirrorMode(!this.mirrorMode));
      this.saveOrbitViewButton?.addEventListener("click", () => this.saveOrbitViewSetting());
      this.restoreOrbitViewButton?.addEventListener("click", () => this.restoreSavedOrbitView());
      this.saveCameraSettingsButton?.addEventListener("click", () => this.saveCameraConfigurationSetting());
      this.resetCameraSettingsButton?.addEventListener("click", () => this.resetCameraConfigurationSetting());
      this.updateOrbitViewControls();
      this.setViewMode("rendered", { silent: true });

      this.toolButtons.forEach((button) => {
        if (button.dataset.tool === "clone") {
          return;
        }
        button.addEventListener("click", () => this.setTool(button.dataset.tool));
      });
      this.setTool("paint");
      this.updateUndoButton();
      this.undoButton?.addEventListener("click", () => this.undoLastEdit());
      this.redoButton?.addEventListener("click", () => this.redoLastEdit());
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.tutorialDrawerOpen) {
          event.preventDefault();
          this.setTutorialDrawerOpen(false);
          return;
        }
        const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z";
        const isRedo = (event.metaKey || event.ctrlKey)
          && ((event.shiftKey && event.key.toLowerCase() === "z") || event.key.toLowerCase() === "y");
        if (!isUndo || event.target?.matches?.("input, textarea, select")) {
          if (!isRedo || event.target?.matches?.("input, textarea, select")) {
            return;
          }
          event.preventDefault();
          this.redoLastEdit();
          return;
        }
        event.preventDefault();
        this.undoLastEdit();
      });

      this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
      this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
      this.canvas.addEventListener("mousedown", (event) => this.onCanvasClick?.(event));
      this.canvas.addEventListener("click", (event) => this.onCanvasClick?.(event));
      this.canvas.addEventListener("pointerleave", () => this.hideTextureBrushCursor?.());
      window.addEventListener("pointerup", () => {
        this.draggingPoseControl = false;
        this.endPoseControlUndo();
        this.onPointerUp();
      });

      this.clearSelectionButton.addEventListener("click", () => this.withSelectionUndo?.("Clear selection", () => this.clearSelection()));
      this.clearAllSelectionButton.addEventListener("click", () => this.withUndo("Reset all", () => this.resetWeights()));
      this.invertSelectionButton.addEventListener("click", () => this.withSelectionUndo?.("Invert selection", () => this.invertSelection()));
      this.removeWeightButton.addEventListener("click", () => {
        this.withUndo("De-weight", () => this.removeBoneInfluenceFromSelection(this.boneSelect.value));
      });
      this.resetWeightsButton.addEventListener("click", () => this.withUndo("Reset weights", () => this.resetWeights()));
      this.redistributeChainWeightsButton?.addEventListener("click", () => {
        this.withUndo("Distribute chain", () => {
          const chainRoot = this.ensureBoneChainForDistribution?.();
          return chainRoot ? this.redistributeSelectionAcrossBoneChain(chainRoot) : 0;
        });
      });
      this.selectionInfluenceList.addEventListener("input", (event) => {
        const slider = event.target.closest("[data-adjust-influence]");
        if (!slider) {
          return;
        }
        const value = slider.closest(".selection-influence-row")?.querySelector(".selection-influence-value");
        if (value) {
          value.textContent = `${Math.round(Number(slider.value) * 100)}%`;
        }
      });
      this.selectionInfluenceList.addEventListener("change", (event) => {
        const slider = event.target.closest("[data-adjust-influence]");
        if (!slider) {
          return;
        }
        this.withUndo("Adjust influence", () => this.adjustSelectionInfluenceFromControl(slider.dataset.adjustInfluence, Number(slider.value)));
      });
      this.updateRangeOutputs();
      const syncSelectionBrushRadius = () => {
        this.updateRangeOutputs();
        this.updateBrushCursorForLastPointer?.();
      };
      this.brushRadius?.addEventListener("input", syncSelectionBrushRadius);
      this.brushRadius?.addEventListener("change", syncSelectionBrushRadius);
      this.throughSelectionToggle?.addEventListener("change", () => {
        this.setStatus(this.throughSelectionToggle.checked ? "Through selection on" : "Through selection off");
        this.updateBrushCursorForLastPointer?.();
      });
      this.sculptStrength.addEventListener("input", () => this.updateRangeOutputs());
      this.moveSensitivity.addEventListener("input", () => this.updateRangeOutputs());
      this.textureBrushRadius?.addEventListener("input", () => {
        this.updateRangeOutputs();
        this.updateBrushCursorForLastPointer?.();
      });
      this.textureBrushOpacity?.addEventListener("input", () => this.updateRangeOutputs());
      this.textureBrushHardness?.addEventListener("input", () => this.updateRangeOutputs());
      this.textureBrushScatter?.addEventListener("input", () => this.updateRangeOutputs());
      this.clonePaintSourceButton?.addEventListener("click", () => {
        this.captureClonePaintSource?.();
      });
      this.clonePaintTargetButton?.addEventListener("click", () => {
        this.captureClonePaintTarget?.();
      });
      this.clonePaintToolButton?.addEventListener("click", () => {
        this.activateClonePaintTool?.();
      });
      this.clonePaintClearButton?.addEventListener("click", () => {
        this.clearClonePaintState?.();
      });
      this.clonePaintCopyJsonButton?.addEventListener("click", () => {
        void this.copyClonePaintReplayJson?.();
      });
      this.textureFillRegionButton?.addEventListener("click", () => {
        this.paintTextureRegion?.();
      });
      this.speedControl?.addEventListener("input", () => this.updateRangeOutputs());
      this.scaleControl?.addEventListener("input", () => {
        this.setActorScaleFromControlValue(Number(this.scaleControl.value) || 0);
      });
      this.timelineBlendControl?.addEventListener("input", () => {
        this.updateBlendOutput();
        this.syncSequenceControls();
        if (this.sequencePlaying) {
          this.stopSequencePreview({ applyPose: true });
        }
      });
      this.boneSelect.addEventListener("change", () => {
        this.setActiveBone(this.boneSelect.value, { clearBoneChain: true });
      });
      this.boneChainSelect?.addEventListener("change", () => {
        this.selectBoneChain(this.boneChainSelect.value);
      });
      this.boneChainSelect?.addEventListener("click", () => {
        if (this.boneChainSelect.value) {
          this.selectBoneChain(this.boneChainSelect.value);
        }
      });
      this.poseBoneSelect.addEventListener("change", () => {
        this.setActiveBone(this.poseBoneSelect.value, {
          clearBoneChain: true,
          preserveBoneChainMemberSelection: true
        });
        this.selectSingleBoneChainMember?.(this.poseBoneSelect.value);
        this.syncPoseControls();
        this.syncJointConstraintControls?.();
        this.clearJointConstraintEditedPoseChannels?.(this.poseBoneSelect.value);
        this.updateBoneLayerList();
      });
      for (const [input, channel] of [
        [this.poseRotX, "x"],
        [this.poseRotY, "y"],
        [this.poseRotZ, "z"],
        [this.posePosX, "px"],
        [this.posePosY, "py"],
        [this.posePosZ, "pz"]
      ]) {
        input.addEventListener("pointerdown", () => {
          this.beginPoseControlUndo();
          this.draggingPoseControl = true;
        });
        input.addEventListener("pointerup", () => {
          this.draggingPoseControl = false;
          this.endPoseControlUndo();
        });
        input.addEventListener("focus", () => this.beginPoseControlUndo());
        input.addEventListener("blur", () => {
          this.draggingPoseControl = false;
          this.endPoseControlUndo();
        });
        input.addEventListener("input", () => {
          this.beginPoseControlUndo();
          this.markJointConstraintPoseChannelEdited?.(channel);
          this.pausePlayback();
          this.updateManualPoseFromControls({ channel });
        });
      }
      for (const [range, numberInput, channel] of [
        [this.poseRotX, this.poseRotXValue, "x"],
        [this.poseRotY, this.poseRotYValue, "y"],
        [this.poseRotZ, this.poseRotZValue, "z"],
        [this.posePosX, this.posePosXValue, "px"],
        [this.posePosY, this.posePosYValue, "py"],
        [this.posePosZ, this.posePosZValue, "pz"]
      ]) {
        if (numberInput?.tagName !== "INPUT") {
          continue;
        }
        const applyNumberInput = () => {
          const value = Number(numberInput.value);
          if (!Number.isFinite(value)) {
            return;
          }
          this.beginPoseControlUndo();
          this.expandPoseControlDomainForValue(channel, value);
          range.value = String(value);
          this.markJointConstraintPoseChannelEdited?.(channel);
          this.pausePlayback();
          this.updateManualPoseFromControls({ channel });
        };
        numberInput.addEventListener("pointerdown", () => {
          this.beginPoseControlUndo();
          this.draggingPoseControl = true;
        });
        numberInput.addEventListener("focus", () => this.beginPoseControlUndo());
        numberInput.addEventListener("input", applyNumberInput);
        numberInput.addEventListener("change", applyNumberInput);
        numberInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            applyNumberInput();
            numberInput.blur();
          }
        });
        numberInput.addEventListener("blur", () => {
          this.draggingPoseControl = false;
          this.endPoseControlUndo();
        });
      }
      this.clearPoseButton?.addEventListener("click", () => this.withUndo("Clear pose", () => this.clearCurrentPose()));
      this.keyCurrentPoseButton.addEventListener("click", () => (
        this.withUndo("Key pose", () => this.keyCurrentPose(), { clearManualPose: true })
      ));
      this.copyPoseButton?.addEventListener("click", () => this.copyCurrentPoseToClipboard?.());
      this.pastePoseButton?.addEventListener("click", () => this.withUndo(
        "Paste pose",
        () => this.pastePoseClipboardToCurrentFrame?.()
      ));
      const timelineEditModeLabels = {
        solved: "solved keys",
        adaptive: "adaptive keys",
        additive: "additive kinematics"
      };
      this.motionConversionModeSelect?.addEventListener("change", () => {
        const mode = ["solved", "adaptive", "additive"].includes(this.motionConversionModeSelect.value)
          ? this.motionConversionModeSelect.value
          : "additive";
        this.normalizeTimelineEditMode?.(mode);
        this.withUndo(
          `Use ${timelineEditModeLabels[mode]}`,
          () => this.setTimelineEditMode?.(mode),
          { clearManualPose: true }
        );
      });
      const bindTimelineEditModeToggle = (toggle, mode, label) => {
        toggle?.addEventListener("change", () => {
          if (!toggle.checked) {
            return;
          }
          this.normalizeTimelineEditMode?.(mode);
          this.withUndo(
            `Use ${label}`,
            () => this.setTimelineEditMode?.(mode),
            { clearManualPose: true }
          );
        });
      };
      bindTimelineEditModeToggle(this.useTimelineKeysToggle, "solved", "solved keys");
      bindTimelineEditModeToggle(this.adaptiveEditToggle, "adaptive", "adaptive edits");
      bindTimelineEditModeToggle(this.additiveKinematicsToggle, "additive", "additive kinematics");
      this.solvedKeyDetail?.addEventListener("input", () => this.updateRangeOutputs());
      this.solvedKeyDetail?.addEventListener("change", () => {
        void this.rebuildAutoKeyedTimelineFromDetail?.({ pushUndo: true });
      });

      this.playToggle?.addEventListener("click", () => {
        void this.toggleBlendAwarePlayback();
      });
      this.timelinePlayToggle.addEventListener("click", () => {
        void this.toggleBlendAwarePlayback();
      });
      const travelFollowReturnTarget = () => this.rootMotionCameraFollowHomeTarget?.clone?.() || null;
      const shouldReturnTravelFollowCamera = () => Boolean(this.rootMotionCameraFollowHomeTarget || this.rootMotionCameraFollowPoint);
      const returnTravelFollowCamera = (target) => {
        this.returnCameraFromTravelFollow?.({ target, duration: 280 });
      };
      this.restartClip?.addEventListener("click", () => {
        const returnTarget = travelFollowReturnTarget();
        const shouldReturnCamera = shouldReturnTravelFollowCamera();
        this.stopSequencePreview({ applyPose: false, resetElapsed: true });
        this.discardUnkeyedPosePreview({ applyPose: false, syncControls: false });
        this.resetRootMotionPreview?.();
        this.progress = 0;
        if (this.timeScrub) {
          this.timeScrub.value = "0";
        }
        this.applyPose(this.progress);
        this.refreshGroundReferenceForCurrentPose?.();
        this.syncPoseControlsToCurrentBone();
        if (shouldReturnCamera) {
          returnTravelFollowCamera(returnTarget);
        }
        this.setPlayback(true);
      });
      this.timeScrub?.addEventListener("pointerdown", () => {
        this.draggingScrub = true;
      });
      this.timeScrub?.addEventListener("pointerup", () => {
        this.draggingScrub = false;
      });
      this.timeScrub?.addEventListener("input", () => {
        const returnTarget = travelFollowReturnTarget();
        const shouldReturnCamera = shouldReturnTravelFollowCamera();
        this.stopSequencePreview({ applyPose: false, resetElapsed: true });
        this.discardUnkeyedPosePreview({ applyPose: false, syncControls: false });
        this.resetRootMotionPreview?.();
        this.progress = Number(this.timeScrub.value);
        this.syncTimelineControls();
        this.applyPose(this.progress);
        this.refreshGroundReferenceForCurrentPose?.();
        this.syncPoseControlsToCurrentBone();
        this.updateBoneLayerValues({ force: true });
        if (shouldReturnCamera) {
          returnTravelFollowCamera(returnTarget);
        }
      });
      this.timelineScrub.addEventListener("input", () => {
        const returnTarget = travelFollowReturnTarget();
        const shouldReturnCamera = shouldReturnTravelFollowCamera();
        this.stopSequencePreview({ applyPose: false, resetElapsed: true });
        this.pausePlayback();
        this.discardUnkeyedPosePreview({ applyPose: false, syncControls: false });
        this.resetRootMotionPreview?.();
        this.progress = Number(this.timelineScrub.value) / this.timelineFrames;
        if (this.timeScrub) {
          this.timeScrub.value = String(this.progress);
        }
        this.syncTimelineControls();
        this.applyPose(this.progress);
        this.refreshGroundReferenceForCurrentPose?.();
        this.syncPoseControlsToCurrentBone();
        this.updateBoneLayerValues({ force: true });
        if (shouldReturnCamera) {
          returnTravelFollowCamera(returnTarget);
        }
      });
      this.timelinePlayBothButton?.addEventListener("click", () => {
        if (this.sequencePlaying || this.timelinePlayBothButton.textContent === "Stop Sequence") {
          this.stopSequencePreview({ applyPose: true, resetElapsed: true });
        } else {
          void this.playBothSequence();
        }
      });
      this.timelineSequenceScrub?.addEventListener("input", () => {
        const duration = this.sequenceDurationSeconds();
        if (duration <= 0) {
          return;
        }
        this.setPlayback(false);
        this.discardUnkeyedPosePreview({ applyPose: false, syncControls: false });
        this.sequencePlaying = false;
        this.sequenceElapsed = (Number(this.timelineSequenceScrub.value) / 1000) * duration;
        this.applySequencePose();
        this.syncSequenceControls();
        this.updateBoneLayerValues({ force: true });
      });
      this.loopToggle.addEventListener("change", () => {
        if (this.activeClipAction) {
          this.activeClipAction.setLoop(this.loopToggle.checked ? THREE.LoopRepeat : THREE.LoopOnce, this.loopToggle.checked ? Infinity : 1);
          this.activeClipAction.clampWhenFinished = !this.loopToggle.checked;
        }
        if (!this.loopToggle.checked) {
          const returnTarget = travelFollowReturnTarget();
          const shouldReturnCamera = shouldReturnTravelFollowCamera();
          this.resetRootMotionPreview?.();
          this.applyPose(this.progress);
          this.refreshGroundReferenceForCurrentPose?.();
          if (shouldReturnCamera) {
            returnTravelFollowCamera(returnTarget);
          }
        }
      });
      this.travelLoopToggle?.addEventListener("change", () => {
        const turningTravelOff = !this.travelLoopToggle.checked;
        const shouldRefocusTravelCamera = turningTravelOff
          && (this.rootMotionLoopCycles > 0 || shouldReturnTravelFollowCamera());
        const returnTarget = travelFollowReturnTarget();
        if (this.travelLoopToggle.checked && this.loopToggle && !this.loopToggle.checked) {
          this.loopToggle.checked = true;
          if (this.activeClipAction) {
            this.activeClipAction.setLoop(THREE.LoopRepeat, Infinity);
            this.activeClipAction.clampWhenFinished = false;
          }
        }
        this.syncTravelFollowControls?.();
        this.resetRootMotionPreview?.({ clearProfile: true });
        this.applyPose(this.progress);
        this.refreshGroundReferenceForCurrentPose?.();
        const cameraRefocused = shouldRefocusTravelCamera && (
          this.returnCameraFromTravelFollow?.({ target: returnTarget, duration: 280 })
          || this.refocusCameraOnCurrentPose?.({ animate: true, duration: 280 })
        );
        this.setStatus(this.travelLoopToggle.checked
          ? "Travel loop preview: hips/root motion continues across loops"
          : cameraRefocused
            ? "Travel loop preview off; camera panning back"
            : "Travel loop preview off");
      });
      this.travelFollowToggle?.addEventListener("change", () => {
        const turningFollowOff = !this.travelFollowToggle.checked;
        const cameraReturned = turningFollowOff && (
          this.returnCameraFromTravelFollow?.({ duration: 280 }) || false
        );
        if (!turningFollowOff) {
          this.rootMotionCameraFollowPoint = null;
          this.rootMotionCameraFollowHomeTarget = null;
        }
        this.setStatus(this.travelFollowToggle.checked
          ? "Travel camera follow on"
          : cameraReturned
            ? "Travel camera follow off; camera panning back"
            : "Travel camera follow off");
      });
      this.prevKeyButton.addEventListener("click", () => this.goToAdjacentKey(-1));
      this.nextKeyButton.addEventListener("click", () => this.goToAdjacentKey(1));
      this.loopToStartButton?.addEventListener("click", () => this.withUndo(
        "Loop to start",
        () => this.blendSelectedPoseBackToStart?.(),
        { clearManualPose: true }
      ));
      this.deleteKeyButton.addEventListener("click", () => this.withUndo("Delete key", () => this.deleteCurrentKey()));
      this.clearKeysButton.addEventListener("click", () => this.withUndo("Clear keys", () => this.clearKeyframes()));
      this.boneLabelToggle?.addEventListener("change", () => this.updateBoneLabels());

      this.savePatchButton?.addEventListener("click", () => this.savePatchFile());
      this.loadPatchButton?.addEventListener("click", () => {
        if (this.patchFileInput) {
          this.patchFileInput.value = "";
          this.patchFileInput.click();
        }
      });
      this.patchFileInput?.addEventListener("change", () => {
        const file = this.patchFileInput.files?.[0];
        if (file) {
          void this.loadPatchFile(file);
        }
      });
      this.copyPatchButton?.addEventListener("click", async () => {
        this.syncPatchJson();
        try {
          await navigator.clipboard.writeText(this.weightJson.value);
          this.setStatus("Copied weight patch JSON");
        } catch {
          this.weightJson.select();
          this.setStatus("Weight patch JSON selected");
        }
      });
      this.applyPatchJsonButton?.addEventListener("click", () => this.applyPatchJson());
      this.clearPatchButton?.addEventListener("click", () => this.withUndo("Clear patch", () => {
        this.resetWeights();
        this.resetVirtualBones();
        this.clearSelection();
        this.poseKeyframes.clear();
        this.adaptiveGuideKeyframes = new Map();
        this.adaptiveGuideDeltaKeyframes = new Map();
        this.adaptiveGuideCurveHandles = new Map();
        this.poseCurveHandles?.clear?.();
        this.poseKeyframeKinds?.clear?.();
        this.manualPose.clear();
        this.manualPoseAdditiveNames?.clear?.();
        this.poseKeyframeMode = "additive";
        this.poseKeyframesGenerated = false;
        this.clipCleanupEdits.clear();
        this.syncPoseControls();
        this.refreshRigControls();
        this.syncPatchJson();
        this.updateTimelineKeyMarkers();
        this.updateCounts();
        this.setStatus("Cleared patch");
      }));
      this.repairSeamsButton?.addEventListener("click", () => this.repairSeams());
      this.sidePanelToggle?.addEventListener("click", () => {
        if (this.app.classList.contains("is-side-panel-open")) {
          this.hideSidePanelDrawer();
        } else {
          this.showSidePanelDrawer();
        }
      });
      this.sidePanelShowToggle?.addEventListener("click", () => {
        this.showSidePanelDrawer();
      });
      this.sidePanelShowToggle?.addEventListener("pointerdown", (event) => this.beginSidePanelHiddenDrag(event));
      this.sidePanelShowToggle?.addEventListener("pointermove", (event) => this.dragSidePanelHiddenDrag(event));
      this.sidePanelShowToggle?.addEventListener("pointerup", (event) => this.endSidePanelHiddenDrag(event));
      this.sidePanelShowToggle?.addEventListener("pointercancel", (event) => this.endSidePanelHiddenDrag(event));
      this.sidePanelResizeHandle?.addEventListener("pointerdown", (event) => this.beginSidePanelResize(event));
      this.sidePanelResizeHandle?.addEventListener("pointermove", (event) => this.dragSidePanelResize(event));
      this.sidePanelResizeHandle?.addEventListener("pointerup", (event) => this.endSidePanelResize(event));
      this.sidePanelResizeHandle?.addEventListener("pointercancel", (event) => this.endSidePanelResize(event));
      this.sidePanelResizeHandle?.addEventListener("mousedown", (event) => this.beginSidePanelMouseResize(event));
      this.sidePanelResizeHandle?.addEventListener("keydown", (event) => this.handleSidePanelResizeKey(event));
      this.sidePanelResizeHandle?.addEventListener("dblclick", () => this.resetSidePanelWidth());
      this.tutorialsToggle?.addEventListener("click", () => {
        this.setTutorialDrawerOpen(!this.tutorialDrawerOpen);
      });
      this.tutorialCloseButton?.addEventListener("click", () => {
        this.setTutorialDrawerOpen(false);
      });
      this.tutorialBackdrop?.addEventListener("click", () => {
        this.setTutorialDrawerOpen(false);
      });
      this.tutorialEditButton?.addEventListener("click", () => this.setTutorialEditing(true));
      this.tutorialSaveButton?.addEventListener("click", () => this.saveTutorialEdits());
      this.tutorialCancelButton?.addEventListener("click", () => this.cancelTutorialEdits());
      this.tutorialResetButton?.addEventListener("click", () => this.resetTutorialRecipes());
      this.tutorialDrawer?.addEventListener("click", (event) => this.handleTutorialRecipeClick(event));
      this.timelineCompactToggle?.addEventListener("click", () => {
        this.setTimelineCompact(!this.app.classList.contains("is-timeline-compact"));
      });
      this.timelineHideToggle?.addEventListener("click", () => this.hideTimelineDrawer());
      this.timelineShowToggle?.addEventListener("click", () => this.setTimelineHidden(false));
      this.timelineDrawerHandle?.addEventListener("pointerdown", (event) => this.beginTimelineDrawerDrag(event));
      this.timelineDrawerHandle?.addEventListener("pointermove", (event) => this.dragTimelineDrawer(event));
      this.timelineDrawerHandle?.addEventListener("pointerup", (event) => this.endTimelineDrawerDrag(event));
      this.timelineDrawerHandle?.addEventListener("pointercancel", (event) => this.endTimelineDrawerDrag(event));
      this.timelineDrawerHandle?.addEventListener("keydown", (event) => this.handleTimelineDrawerKey(event));
      this.timelineDrawerHandle?.addEventListener("dblclick", () => this.resetTimelineDrawerHeight());
      this.timelineDrawerPanel()?.addEventListener("pointerdown", (event) => this.beginTimelineDrawerEdgeDrag(event));
      this.timelineDrawerPanel()?.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
      this.boundTimelineDrawerEdgePointerDown = this.boundTimelineDrawerEdgePointerDown
        || ((event) => this.beginTimelineGlobalEdgeDrag(event));
      window.addEventListener("pointerdown", this.boundTimelineDrawerEdgePointerDown, { capture: true });
      this.timelineShowToggle?.addEventListener("pointerdown", (event) => this.beginTimelineHiddenDrawerDrag(event));
      this.timelineShowToggle?.addEventListener("pointermove", (event) => this.dragTimelineHiddenDrawer(event));
      this.timelineShowToggle?.addEventListener("pointerup", (event) => this.endTimelineHiddenDrawerDrag(event));
      this.timelineShowToggle?.addEventListener("pointercancel", (event) => this.endTimelineHiddenDrawerDrag(event));

      document.querySelectorAll("[data-camera]").forEach((button) => {
        button.addEventListener("click", () => this.setCameraPreset(button.dataset.camera));
      });
      document.querySelectorAll("[data-camera-axis]").forEach((button) => {
        button.addEventListener("pointerdown", (event) => this.beginCameraAxisDrag(event, button.dataset.cameraAxis));
        button.addEventListener("pointermove", (event) => this.dragCameraGizmo(event));
        button.addEventListener("pointerup", (event) => this.endCameraGizmoDrag(event));
        button.addEventListener("pointercancel", (event) => this.endCameraGizmoDrag(event));
      });
      this.cameraGizmoPad?.addEventListener("pointerdown", (event) => this.beginCameraGizmoDrag(event));
      this.cameraGizmoPad?.addEventListener("pointermove", (event) => this.dragCameraGizmo(event));
      this.cameraGizmoPad?.addEventListener("pointerup", (event) => this.endCameraGizmoDrag(event));
      this.cameraGizmoPad?.addEventListener("pointercancel", (event) => this.endCameraGizmoDrag(event));
      this.cameraGizmoPad?.addEventListener("dblclick", () => this.resetCameraRoll());
      this.cameraRollLeftButton?.addEventListener("click", () => this.rollCameraBy(-Math.PI / 2));
      this.cameraRollRightButton?.addEventListener("click", () => this.rollCameraBy(Math.PI / 2));
      this.cameraRollResetButton?.addEventListener("click", () => this.resetCameraRoll());
      this.cameraGizmoSpeed?.addEventListener("input", () => this.updateRangeOutputs());
      this.cameraBackgroundColor?.addEventListener("input", () => this.applyBackgroundColor(this.cameraBackgroundColor.value));
      this.cameraMeshColor?.addEventListener("input", () => this.applyMeshColor(this.cameraMeshColor.value));
      for (const input of [
        this.cameraAmbientLight,
        this.cameraKeyLight,
        this.cameraRimLight,
        this.cameraTextureGain
      ]) {
        input?.addEventListener("input", () => this.applySceneLighting());
      }
    },

    applyBackgroundColor(value) {
      const color = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#11171c";
      this.backgroundColor = color;
      if (this.cameraBackgroundColor && this.cameraBackgroundColor.value !== color) {
        this.cameraBackgroundColor.value = color;
      }
      this.renderer?.setClearColor(color, 1);
      if (this.scene?.fog) {
        this.scene.fog.color.set(color);
      }
    },

    applyMeshColor(value) {
      const color = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#80d8ff";
      this.meshColor = color;
      if (this.cameraMeshColor && this.cameraMeshColor.value !== color) {
        this.cameraMeshColor.value = color;
      }
      if (this.meshWireOverlayMaterial?.color) {
        this.meshWireOverlayMaterial.color.set(color);
        this.meshWireOverlayMaterial.needsUpdate = true;
      }
      for (const overlay of this.meshWireOverlays || []) {
        const material = overlay?.material;
        const materials = Array.isArray(material) ? material : material ? [material] : [];
        for (const item of materials) {
          if (item?.color) {
            item.color.set(color);
            item.needsUpdate = true;
          }
        }
      }
      this.updateMeshWireOverlays?.();
    },

    lightingControlValue(input, fallback) {
      const value = Number(input?.value);
      return Number.isFinite(value) ? value : fallback;
    },

    applySceneLighting() {
      const levels = {
        ambient: this.lightingControlValue(this.cameraAmbientLight, this.sceneLightLevels?.ambient ?? 0.75),
        key: this.lightingControlValue(this.cameraKeyLight, this.sceneLightLevels?.key ?? 1.25),
        rim: this.lightingControlValue(this.cameraRimLight, this.sceneLightLevels?.rim ?? 0.35)
      };
      const textureGain = this.lightingControlValue(this.cameraTextureGain, this.textureGain ?? 1);

      this.sceneLightLevels = levels;
      this.textureGain = textureGain;
      if (this.ambientSceneLight) {
        this.ambientSceneLight.intensity = levels.ambient;
      }
      if (this.keySceneLight) {
        this.keySceneLight.intensity = levels.key;
      }
      if (this.rimSceneLight) {
        this.rimSceneLight.intensity = levels.rim;
      }
      this.updateCameraRelativeLights();
      this.applyTextureGainToModel?.();
      this.updateRangeOutputs?.();
    },

    updateCameraRelativeLights() {
      if (!this.rimSceneLight || !this.camera || !this.controls) {
        return;
      }
      const target = this.controls.target;
      const viewOffset = new THREE.Vector3().subVectors(this.camera.position, target);
      const distance = Math.max(viewOffset.length(), 1);
      const viewDirection = viewOffset.normalize();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();

      this.rimSceneLight.target.position.copy(target);
      this.rimSceneLight.position
        .copy(target)
        .addScaledVector(viewDirection, distance * 0.35)
        .addScaledVector(right, -distance * 0.9)
        .addScaledVector(up, distance * 0.55);
      this.rimSceneLight.target.updateMatrixWorld();
    },

    applyTextureGainToModel() {
      this.model?.traverse?.((object) => {
        this.applyTextureGainToMaterial(object.material);
      });
    },

    applyTextureGainToMaterial(material) {
      if (Array.isArray(material)) {
        for (const entry of material) {
          this.applyTextureGainToMaterial(entry);
        }
        return;
      }
      const baseColor = material?.userData?.editorBaseColor;
      if (!baseColor?.isColor || !material?.color) {
        return;
      }
      material.color.copy(baseColor).multiplyScalar(this.textureGain ?? 1);
      if (this.cloneSpotlightActive) {
        material.color.copy(baseColor).multiplyScalar(0.16);
        material.opacity = 0.28;
        material.transparent = true;
        material.depthWrite = false;
      }
      material.needsUpdate = true;
    },

    beginCameraGizmoDrag(event) {
      if (event.target?.closest?.("[data-camera-axis]")) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      this.cameraGizmoDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: this.cameraGizmoPad
      };
      this.cameraGizmoPad?.setPointerCapture?.(event.pointerId);
      this.cameraGizmoPad?.classList.add("is-dragging");
      this.controls.enabled = false;
      this.setStatus("Camera gizmo");
    },

    beginCameraAxisDrag(event, axis) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation?.();
      const target = event.currentTarget;
      this.cameraGizmoDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        axis,
        target
      };
      target?.setPointerCapture?.(event.pointerId);
      target?.classList.add("is-dragging");
      this.cameraGizmoPad?.classList.add("is-dragging");
      this.controls.enabled = false;
      this.setStatus(`Camera ${String(axis || "").toUpperCase()} axis`);
    },

    dragCameraGizmo(event) {
      if (!this.cameraGizmoDrag || this.cameraGizmoDrag.pointerId !== event.pointerId) {
        return;
      }
      if (event.buttons !== undefined && (event.buttons & 1) !== 1) {
        this.endCameraGizmoDrag(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation?.();
      const dx = event.clientX - this.cameraGizmoDrag.x;
      const dy = event.clientY - this.cameraGizmoDrag.y;
      this.cameraGizmoDrag.x = event.clientX;
      this.cameraGizmoDrag.y = event.clientY;
      if (this.cameraGizmoDrag.axis) {
        this.rotateCameraAxisByPixels(this.cameraGizmoDrag.axis, dx, dy);
      } else {
        this.orbitCameraByPixels(dx, dy);
      }
    },

    endCameraGizmoDrag(event) {
      if (!this.cameraGizmoDrag || this.cameraGizmoDrag.pointerId !== event.pointerId) {
        return;
      }
      event.stopPropagation?.();
      this.cameraGizmoDrag.target?.releasePointerCapture?.(event.pointerId);
      this.cameraGizmoDrag.target?.classList.remove("is-dragging");
      this.cameraGizmoPad?.classList.remove("is-dragging");
      const axis = this.cameraGizmoDrag.axis;
      this.cameraGizmoDrag = null;
      this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
      this.setStatus(axis ? `Camera ${String(axis).toUpperCase()} axis ready` : "Camera gizmo ready");
    },

    orbitCameraByPixels(dx, dy) {
      if (!this.camera || !this.controls) {
        return;
      }
      const target = this.controls.target;
      const offset = this.camera.position.clone().sub(target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      const speed = this.cameraGizmoSpeedValue();
      spherical.theta -= dx * speed;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - dy * speed, 0.04, Math.PI - 0.04);
      offset.setFromSpherical(spherical);
      this.camera.position.copy(target).add(offset);
      this.camera.lookAt(target);
      this.controls.update();
      this.updateBoneLabels?.();
    },

    cameraGizmoSpeedValue() {
      const value = Number(this.cameraGizmoSpeed?.value);
      return Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0.0005, 0.02) : 0.02;
    },

    rotateCameraAxisByPixels(axisName, dx, dy) {
      const speed = this.cameraGizmoSpeedValue();
      const axis = String(axisName || "").toLowerCase();
      const angle = axis === "x"
        ? -dy * speed
        : axis === "y"
          ? -dx * speed
          : dx * speed;
      this.rotateCameraAroundAxis(axis, angle);
    },

    rotateCameraAroundAxis(axisName, angleRadians) {
      if (!this.camera || !this.controls || !Number.isFinite(angleRadians) || Math.abs(angleRadians) < 0.000001) {
        return;
      }
      const target = this.controls.target;
      if (axisName === "z") {
        this.rollCameraBy(angleRadians, { silent: true });
        return;
      }
      const axis = axisName === "x"
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const offset = this.camera.position.clone().sub(target).applyAxisAngle(axis, angleRadians);
      this.camera.position.copy(target).add(offset);
      this.camera.up.applyAxisAngle(axis, angleRadians).normalize();
      this.camera.lookAt(target);
      this.controls.update();
      this.updateBoneLabels?.();
    },

    rollCameraBy(angleRadians, options = {}) {
      if (!this.camera || !this.controls) {
        return;
      }
      const axis = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
      this.camera.up.applyAxisAngle(axis, angleRadians).normalize();
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.updateBoneLabels?.();
      if (!options.silent) {
        this.setStatus(`Camera rolled ${Math.round(THREE.MathUtils.radToDeg(angleRadians))} degrees`);
      }
    },

    resetCameraRoll() {
      if (!this.camera || !this.controls) {
        return;
      }
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.updateBoneLabels?.();
      this.setStatus("Camera roll reset");
    },

    captureUndoState(label = "Edit", options = {}) {
      if (!this.model || !this.weightJson) {
        return null;
      }
      const patch = this.syncPatchJson();
      const state = {
        label,
        patch,
        patchText: this.serializePatchText?.(patch).trimEnd() || this.weightJson.value,
        selected: this.paintRecords.map((record) => [...record.selected]),
        activeBoneName: this.activeBoneName,
        poseBoneName: this.poseBoneSelect?.value || "",
        selectedBoneChainRootName: this.selectedBoneChainRootName,
        progress: this.progress,
        poseGizmoMode: this.activePoseGizmoMode?.() || "",
        rigEditor: this.captureRigEditorUndoState?.() || null,
        includeClip: Boolean(options.includeClip),
        clipCleanupEdits: this.serializeClipCleanupEdits?.() || [],
        poseKeyframeMode: this.poseKeyframeMode,
        poseKeyframesGenerated: Boolean(this.poseKeyframesGenerated),
        timelineKeysSourceWasAutoGenerated: Boolean(this.timelineKeysSourceWasAutoGenerated),
        poseKeyframes: this.serializePoseKeyframes?.() || [],
        adaptiveGuideKeyframes: this.serializePoseKeyframeMap?.(this.adaptiveGuideKeyframes) || [],
        adaptiveGuideDeltaKeyframes: this.serializePoseKeyframeMap?.(this.adaptiveGuideDeltaKeyframes) || [],
        adaptiveGuideCurveHandles: this.serializeAdaptiveGuideCurveHandles?.() || [],
        adaptivePoseKeyframes: this.serializePoseKeyframeMap?.(this.adaptivePoseKeyframes) || [],
        poseCurveHandles: this.serializePoseCurveHandles?.() || [],
        poseKeyframeKinds: this.serializePoseKeyframeKinds?.() || [],
        manualPoseAdditiveNames: [...(this.manualPoseAdditiveNames || [])],
        manualPose: options.clearManualPose
          ? []
          : [...this.manualPose.entries()].map(([name, pose]) => [name, { ...pose }])
      };
      if (options.includeClip) {
        state.clipState = this.captureActiveClipUndoState();
      }
      return state;
    },

    captureActiveClipUndoState() {
      const entry = this.activeClipEntry;
      if (!entry) {
        return null;
      }
      return {
        entryId: entry.id || entry.name || "",
        sourceClip: entry.sourceClip?.clone?.() || null,
        clip: entry.clip?.clone?.() || null,
        startOffsetSeconds: entry.startOffsetSeconds || 0
      };
    },

    restoreActiveClipUndoState(clipState) {
      if (!clipState) {
        return false;
      }
      const entry = this.clipEntries.find((candidate) => (
        (candidate.id || candidate.name || "") === clipState.entryId
      )) || this.activeClipEntry;
      if (!entry) {
        return false;
      }
      entry.sourceClip = clipState.sourceClip?.clone?.() || null;
      entry.clip = clipState.clip?.clone?.() || null;
      entry.startOffsetSeconds = clipState.startOffsetSeconds || 0;
      this.activeClipEntry = entry;
      if (entry.clip) {
        void this.playClipEntry(entry);
      }
      this.syncClipCleanupControls?.();
      return true;
    },

    pushUndoState(label = "Edit", options = {}) {
      const state = this.captureUndoState(label, options);
      if (!state) {
        return false;
      }
      this.undoStack.push(state);
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      if (!options.preserveRedo) {
        this.redoStack = [];
      }
      this.updateUndoButton();
      return true;
    },

    withUndo(label, callback, options = {}) {
      this.pushUndoState(label, options);
      return callback?.();
    },

    pushRigUndoState(label = "Rig edit", options = {}) {
      const before = options.before || this.captureRigHistorySnapshot?.();
      const after = options.after || this.captureRigHistorySnapshot?.();
      if (!before || !after || this.rigHistorySnapshotsMatch?.(before, after)) {
        return false;
      }
      const state = {
        kind: "rig",
        label,
        before,
        after
      };
      this.undoStack.push(state);
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      if (!options.preserveRedo) {
        for (const redoState of this.redoStack || []) {
          this.disposeFastHistoryState?.(redoState);
        }
        this.redoStack = [];
      }
      this.updateUndoButton();
      return true;
    },

    withRigUndo(label, callback, options = {}) {
      const before = this.captureRigHistorySnapshot?.();
      const result = callback?.();
      const after = this.captureRigHistorySnapshot?.();
      this.pushRigUndoState(label, { ...options, before, after });
      return result;
    },

    beginPoseControlUndo(label = "Pose edit") {
      if (this.poseControlUndoActive && this.undoStack.length) {
        return false;
      }
      this.poseControlUndoActive = this.pushUndoState(label);
      return this.poseControlUndoActive;
    },

    endPoseControlUndo() {
      this.poseControlUndoActive = false;
    },

    updateUndoButton() {
      const busy = Boolean(this.historyRestoreBusy);
      if (this.undoButton) {
        this.undoButton.disabled = busy || !this.undoStack.length;
      }
      if (this.redoButton) {
        this.redoButton.disabled = busy || !this.redoStack?.length;
      }
    },

    scheduleHistoryFrame(callback) {
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (handler) => setTimeout(handler, 0);
      requestFrame(callback);
    },

    finishHistoryRestore() {
      this.scheduleHistoryFrame(() => {
        const queuedStep = this.pendingHistoryStep;
        this.pendingHistoryStep = null;
        this.historyRestoreBusy = false;
        this.updateUndoButton();
        if (queuedStep) {
          this.runHistoryStep(queuedStep);
        }
      });
    },

    runHistoryStep(direction) {
      if (this.historyRestoreBusy) {
        this.pendingHistoryStep = direction;
        this.setStatus(direction === "redo" ? "Redo queued" : "Undo queued");
        return false;
      }
      this.historyRestoreBusy = true;
      this.pendingHistoryStep = null;
      this.updateUndoButton();
      this.setStatus(direction === "redo" ? "Redoing..." : "Undoing...");
      this.scheduleHistoryFrame(() => {
        try {
          if (direction === "redo") {
            this.performRedoLastEdit();
          } else {
            this.performUndoLastEdit();
          }
        } finally {
          this.finishHistoryRestore();
        }
      });
      return true;
    },

    refreshRestoredPose() {
      this.lastClipSampleTime = null;
      this.forceNextClipSample = true;
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      for (const record of this.paintRecords || []) {
        record.object?.skeleton?.update?.();
      }
      this.updateSkeletonHelper?.();
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      if (this.showBonesLayer) {
        this.updateBoneLabels();
      }
    },

    restoreEditorState(state, statusPrefix, options = {}) {
      this.poseControlUndoActive = false;
      this.boneMoveDrag = null;
      this.ikDrag = null;
      if (!state) {
        return false;
      }
      const restoreEditorChrome = options.restoreEditorChrome !== false;
      const patch = state.patch || JSON.parse(state.patchText);
      this.setPatchJsonFromPatch?.(patch);
      this.lastClipSampleTime = null;
      this.applyPatchObject?.(patch, { status: false, applyPose: false });
      if (Array.isArray(state.poseKeyframes)) {
        this.applySerializedPoseKeyframes?.(state.poseKeyframes);
        this.applySerializedPoseCurveHandles?.(state.poseCurveHandles || []);
        this.applySerializedPoseKeyframeKinds?.(state.poseKeyframeKinds || []);
        this.poseKeyframeMode = state.poseKeyframeMode === "replace" ? "replace" : "additive";
        this.poseKeyframesGenerated = Boolean(state.poseKeyframesGenerated);
        this.timelineKeysSourceWasAutoGenerated = Boolean(state.timelineKeysSourceWasAutoGenerated);
      }
      if (Array.isArray(state.adaptivePoseKeyframes)) {
        this.adaptivePoseKeyframes = this.serializedPoseKeyframeMap?.(state.adaptivePoseKeyframes) || new Map();
      }
      this.adaptiveGuideKeyframes = Array.isArray(state.adaptiveGuideKeyframes)
        ? this.serializedPoseKeyframeMap?.(state.adaptiveGuideKeyframes) || new Map()
        : new Map();
      this.adaptiveGuideDeltaKeyframes = Array.isArray(state.adaptiveGuideDeltaKeyframes)
        ? this.serializedPoseKeyframeMap?.(state.adaptiveGuideDeltaKeyframes) || new Map()
        : new Map();
      this.applySerializedAdaptiveGuideCurveHandles?.(state.adaptiveGuideCurveHandles || []);
      if (Array.isArray(state.clipCleanupEdits)) {
        this.applySerializedClipCleanupEdits?.(state.clipCleanupEdits);
      }
      this.restoreActiveClipUndoState(state.clipState);
      this.manualPose = new Map((state.manualPose || [])
        .filter(([name]) => this.bones.has(name))
        .map(([name, pose]) => [name, { ...pose }]));
      this.manualPoseAdditiveNames = new Set((state.manualPoseAdditiveNames || [])
        .filter((name) => this.manualPose.has(name)));
      state.selected.forEach((selected, index) => {
        const record = this.paintRecords[index];
        if (!record) {
          return;
        }
        record.selected = new Set(selected.filter((vertexIndex) => (
          vertexIndex < record.geometry.attributes.position.count && !record.deleted?.has(vertexIndex)
        )));
        this.updateRecordColors(record);
      });
      if (restoreEditorChrome && state.activeBoneName && this.bones.has(state.activeBoneName)) {
        this.setActiveBone(state.activeBoneName);
      }
      if (restoreEditorChrome && state.poseBoneName && this.bones.has(state.poseBoneName)) {
        this.poseBoneSelect.value = state.poseBoneName;
        this.setActiveBone(state.poseBoneName);
      }
      if (restoreEditorChrome) {
        this.selectedBoneChainRootName = state.selectedBoneChainRootName || "";
        this.renderBoneChainOptions?.();
        this.renderAddBoneChainMemberOptions?.();
        this.restoreRigEditorUndoState?.(state.rigEditor);
      }
      if (Number.isFinite(state.progress)) {
        this.progress = THREE.MathUtils.clamp(state.progress, 0, 1);
        this.timeScrub.value = String(this.progress);
        this.syncTimelineControls();
      }
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.refreshRestoredPose();
      if (state.includeClip || state.clipState || Array.isArray(state.clipCleanupEdits)) {
        window.requestAnimationFrame(() => this.refreshRestoredPose());
      }
      this.syncPoseControlsToCurrentBone();
      this.flushPoseUpdates?.();
      if (restoreEditorChrome) {
        this.restorePoseGizmoMode?.(state.poseGizmoMode || "");
      }
      this.syncPatchJson();
      this.updateCounts();
      this.updateUndoButton();
      this.setStatus(`${statusPrefix} ${state.label}`);
      return true;
    },

    undoLastEdit() {
      if (!this.historyRestoreBusy && this.isFastHistoryState(this.undoStack[this.undoStack.length - 1])) {
        return this.performUndoLastEdit();
      }
      return this.runHistoryStep("undo");
    },

    performUndoLastEdit() {
      const state = this.undoStack.pop();
      if (!state) {
        this.updateUndoButton();
        this.setStatus("Nothing to undo");
        return false;
      }
      if (this.isFastHistoryState(state)) {
        this.redoStack.push(state);
        if (this.redoStack.length > this.maxUndoSteps) {
          this.disposeFastHistoryState?.(this.redoStack.shift());
        }
        return this.applyFastHistoryState(state, "undo", "Undid");
      }
      const current = this.captureUndoState(state.label, { includeClip: Boolean(state.includeClip || state.clipState) });
      if (current) {
        this.redoStack.push(current);
        if (this.redoStack.length > this.maxUndoSteps) {
          this.redoStack.shift();
        }
      }
      return this.restoreEditorState(state, "Undid");
    },

    redoLastEdit() {
      if (!this.historyRestoreBusy && this.isFastHistoryState(this.redoStack?.[this.redoStack.length - 1])) {
        return this.performRedoLastEdit();
      }
      return this.runHistoryStep("redo");
    },

    performRedoLastEdit() {
      const state = this.redoStack?.pop();
      if (!state) {
        this.updateUndoButton();
        this.setStatus("Nothing to redo");
        return false;
      }
      if (this.isFastHistoryState(state)) {
        this.undoStack.push(state);
        if (this.undoStack.length > this.maxUndoSteps) {
          this.disposeFastHistoryState?.(this.undoStack.shift());
        }
        return this.applyFastHistoryState(state, "redo", "Redid");
      }
      const current = this.captureUndoState(state.label, { includeClip: Boolean(state.includeClip || state.clipState) });
      if (current) {
        this.undoStack.push(current);
        if (this.undoStack.length > this.maxUndoSteps) {
          this.undoStack.shift();
        }
      }
      return this.restoreEditorState(state, "Redid");
    },

    clearRedoStack() {
      for (const state of this.redoStack || []) {
        this.disposeFastHistoryState?.(state);
      }
      this.redoStack = [];
      this.updateUndoButton();
      return true;
    },

    isFastHistoryState(state) {
      return state?.kind === "selection" || state?.kind === "texture-paint" || state?.kind === "rig";
    },

    disposeFastHistoryState(state) {
      if (state?.kind === "texture-paint") {
        for (const entry of state.entries || []) {
          this.disposeTexturePaintSnapshotEntry?.(entry);
        }
      }
    },

    applyFastHistoryState(state, direction, statusPrefix) {
      if (state?.kind === "selection") {
        const snapshot = direction === "redo" ? state.after : state.before;
        if (!Array.isArray(snapshot)) {
          return false;
        }
        this.restoreSelectionSnapshot?.(snapshot);
      } else if (state?.kind === "texture-paint") {
        this.restoreTexturePaintSnapshot?.(state.entries, direction === "redo" ? "after" : "before");
      } else if (state?.kind === "rig") {
        this.restoreRigHistorySnapshot?.(direction === "redo" ? state.after : state.before);
      } else {
        return false;
      }
      this.updateUndoButton();
      this.setStatus(`${statusPrefix} ${state.label}`);
      return true;
    },

    setTool(tool, options = {}) {
      if (tool !== this.activeTool) {
        if (this.usesSelectionStrokeUndo?.(this.activeTool)) {
          this.endSelectionStrokeUndo?.();
        }
        if (this.usesTextureStrokeUndo?.(this.activeTool)) {
          this.endTexturePaintStrokeUndo?.();
        }
        this.texturePaintStrokePoint = null;
      }
      if (tool !== "neighbor") {
        this.neighborStroke = null;
        if (this.neighborHoverMarker) {
          this.neighborHoverMarker.visible = false;
        }
      }
      if (tool !== "lasso") {
        this.lassoStroke = null;
        this.hideLassoOverlay?.();
      }
      if (tool !== "clone") {
        this.canvas?.classList.remove("is-clone-stamp");
      }
      if (tool !== "eyedropper") {
        this.canvas?.classList.remove("is-texture-eyedropper");
      }
      if (tool !== "airbrush") {
        this.canvas?.classList.remove("is-texture-airbrush");
      }
      if (!this.usesSelectionBrushCursor?.(tool)) {
        this.canvas?.classList.remove("is-selection-brush");
      }
      if (tool !== "clone" && tool !== "airbrush" && !this.usesSelectionBrushCursor?.(tool)) {
        this.hideTextureBrushCursor?.();
      }
      if (tool !== "bone") {
        this.preparePoseGizmoModeSwitch?.("");
        this.setBonePlacementPending?.(false);
      }
      this.activeTool = tool;
      this.controls.enabled = tool === "orbit" || tool === "bone";
      this.app?.classList.toggle("is-clone-stamp", tool === "clone");
      this.canvas?.classList.toggle("is-clone-stamp", tool === "clone");
      this.app?.classList.toggle("is-texture-eyedropper", tool === "eyedropper");
      this.canvas?.classList.toggle("is-texture-eyedropper", tool === "eyedropper");
      this.app?.classList.toggle("is-texture-airbrush", tool === "airbrush");
      this.canvas?.classList.toggle("is-texture-airbrush", tool === "airbrush");
      const isSelectionBrush = this.usesSelectionBrushCursor?.(tool) === true;
      this.app?.classList.toggle("is-selection-brush", isSelectionBrush);
      this.canvas?.classList.toggle("is-selection-brush", isSelectionBrush);
      if (this.selectionMarkers) {
        this.selectionMarkers.visible = tool === "clone" || this.cloneSpotlightActive
          ? false
          : !this.cleanPreview && this.showSelectionLayer !== false && this.markerVertexCount > 0;
      }
      if (EDIT_ONLY_TOOLS.has(tool)) {
        this.pausePlayback();
        this.setViewMode("edit", { silent: true });
      }
      if (tool === "bone") {
        this.pausePlayback();
        this.setSidePanelOpen(true);
        this.setRigPanelOpen(true);
        if (!options.preserveViewportLayers) {
          this.setViewMode("rendered", { silent: true });
          this.showBonesLayer = true;
          this.syncViewportLayerButtons?.();
          this.updateSkeletonHelper();
        }
        this.updateBonePickerOverlay();
      }
      this.toolButtons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.tool === tool);
      });
      this.updateMoveGizmo();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
      this.updateGizmoOnlyPreviewButton?.();
      this.updateNeighborHover?.();
      this.syncClonePaintControls?.();
      let usedEraseSelectionCommand = false;
      if (tool === "erase" && this.viewMode === "edit" && this.hasSelection()) {
        usedEraseSelectionCommand = this.withUndo("Clean vertices", () => this.cleanSelectedVertices?.()) > 0;
      }
      const labels = {
        paint: "Pen tool",
        lasso: "Lasso: draw around vertices to select the region",
        neighbor: "Neighbor pen: selects connected vertices from the hovered vertex",
        deselect: "Deselect tool: removes painted selection only",
        erase: this.viewMode === "edit" ? "Erase tool: cleans selected vertices from the mesh" : "Erase tool: removes weight and vertex edits",
        move: this.hasSelection() ? "Move selected vertices" : "Move tool needs a painted vertex selection",
        bone: "Bone gizmo tool",
        clone: this.clonePaintSource?.count && this.clonePaintTargets?.size
          ? "Clone paint: brush over the captured region"
          : "Clone paint needs Source and Region captures",
        eyedropper: "Pick texture color from the model",
        airbrush: "Airbrush texture color onto the model",
        pull: "Pull sculpt tool",
        push: "Push sculpt tool",
        orbit: "Orbit camera: left drag rotates, wheel zooms, right drag pans"
      };
      if (!usedEraseSelectionCommand) {
        this.setStatus(labels[tool] || "Ready");
      }
      if (tool === "airbrush") {
        this.scheduleTextureAirbrushPrewarm?.();
      }
      this.recordTutorialMacroToolChange?.(tool);
    },

    viewportLayerState(layer) {
      if (layer === "rendered") {
        return this.showRenderedLayer !== false;
      }
      if (layer === "mesh") {
        return Boolean(this.showMeshLayer);
      }
      if (layer === "selection") {
        return this.showSelectionLayer !== false;
      }
      if (layer === "bones") {
        return Boolean(this.showBonesLayer);
      }
      return false;
    },

    syncViewportLayerButtons() {
      this.viewportLayerButtons?.forEach((button) => {
        const active = this.viewportLayerState(button.dataset.viewportLayer);
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    },

    viewModeForViewportLayers() {
      if (this.showRenderedLayer !== false && this.showMeshLayer) {
        return "both";
      }
      if (this.showMeshLayer) {
        return "mesh";
      }
      return "rendered";
    },

    toggleViewportLayer(layer, options = {}) {
      if (layer === "rendered") {
        this.showRenderedLayer = !this.viewportLayerState("rendered");
      } else if (layer === "mesh") {
        this.showMeshLayer = !this.viewportLayerState("mesh");
      } else if (layer === "selection") {
        this.showSelectionLayer = !this.viewportLayerState("selection");
      } else if (layer === "bones") {
        this.showBonesLayer = !this.viewportLayerState("bones");
      } else {
        return;
      }
      const nextMode = this.viewMode === "edit" ? this.viewMode : this.viewModeForViewportLayers();
      this.setViewMode(nextMode, { silent: true, preserveViewportLayers: true });
      if (!options.silent) {
        const label = {
          rendered: "Rendered",
          mesh: "Mesh",
          selection: "Selection",
          bones: "Bones"
        }[layer] || "Layer";
        this.setStatus(`${label} layer ${this.viewportLayerState(layer) ? "shown" : "hidden"}`);
      }
    },

    setViewMode(mode, options = {}) {
      if (this.activeTool === "clone" && mode === "edit") {
        mode = "both";
      }
      this.viewMode = mode;
      this.app?.classList.toggle("is-3d-edit-mode", mode === "edit");
      if (mode !== "edit" && EDIT_ONLY_TOOLS.has(this.activeTool)) {
        this.activeTool = "paint";
        this.controls.enabled = false;
      }
      this.viewModeButtons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.viewMode === mode);
      });
      if (!options.preserveViewportLayers && mode !== "edit") {
        this.showRenderedLayer = mode !== "mesh";
        this.showMeshLayer = mode === "mesh" || mode === "both";
      }
      this.syncViewportLayerButtons();
      this.toolButtons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.tool === this.activeTool);
      });

      for (const record of this.paintRecords) {
        const renderedVisible = this.cleanPreview || mode === "edit" || this.showRenderedLayer !== false;
        record.object.visible = renderedVisible || (!record.wireOverlay && Boolean(this.showMeshLayer));
        for (const material of this.getObjectMaterials(record.object.material)) {
          material.wireframe = !renderedVisible && !this.cleanPreview && Boolean(this.showMeshLayer);
          material.vertexColors = false;
          material.transparent = !this.cleanPreview && mode === "edit";
          material.opacity = !this.cleanPreview && mode === "edit" ? 0.88 : 1;
          material.depthWrite = this.cleanPreview || mode !== "edit";
          material.needsUpdate = true;
        }
      }

      this.updateSelectionMarkerStyle();
      if (this.selectionMarkers) {
        this.selectionMarkers.visible = this.activeTool === "clone" || this.cloneSpotlightActive
          ? false
          : !this.cleanPreview && this.showSelectionLayer !== false && this.markerVertexCount > 0;
      }

      if (this.vertexMarkers) {
        this.vertexMarkers.visible = !this.cleanPreview && mode === "edit";
        if (!this.cleanPreview && mode === "edit" && this.activeTool !== "bone") {
          this.updateAllVertexMarkers();
        } else {
          this.vertexMarkerCount = 0;
        }
      }

      this.updateMoveGizmo();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
      this.updateNeighborHover?.();
      this.updateSkeletonHelper();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLabels();
      this.syncClonePaintControls?.();
      this.updateMeshWireOverlays?.();

      if (!options.silent) {
        const labels = {
          rendered: "Rendered preview mode",
          mesh: "Mesh mode",
          both: "Rendered + mesh mode",
          edit: "3D edit mode"
        };
        this.setStatus(labels[mode] || "Ready");
      }
    },

    updateSelectionMarkerStyle() {
      if (!this.markerMaterial || !this.selectionMarkers) {
        return;
      }

      const selectedCount = this.markerVertexCount || 0;
      const crowded = selectedCount > 250;
      const dense = selectedCount > 900;
      const rendered = this.viewMode === "rendered" && this.showRenderedLayer !== false;

      this.markerMaterial.size = rendered
        ? (dense ? 2.5 : crowded ? 3.25 : 4)
        : (dense ? 4 : crowded ? 5.5 : 7);
      this.markerMaterial.opacity = rendered
        ? (dense ? 0.44 : crowded ? 0.58 : 0.72)
        : (dense ? 0.62 : crowded ? 0.78 : 0.92);
      this.markerMaterial.depthTest = rendered || dense;
      this.markerMaterial.needsUpdate = true;
      this.selectionMarkers.renderOrder = rendered ? 12 : 20;
    },

    getObjectMaterials(material) {
      if (!material) {
        return [];
      }
      return Array.isArray(material) ? material.filter(Boolean) : [material];
    },

    createMeshWireOverlay(object, geometry) {
      if (!this.scene || !geometry) {
        return null;
      }
      const material = this.meshWireOverlayMaterial || new THREE.MeshBasicMaterial({
        color: this.meshColor || "#80d8ff",
        wireframe: true,
        transparent: true,
        opacity: 0.42,
        depthWrite: false
      });
      const overlay = object.isSkinnedMesh && object.skeleton
        ? new THREE.SkinnedMesh(geometry, material)
        : new THREE.Mesh(geometry, material);
      overlay.name = `${object.name || "mesh"} wire overlay`;
      overlay.frustumCulled = false;
      overlay.renderOrder = 16;
      overlay.visible = false;
      overlay.userData.mixamoCleanupHelper = "wire-overlay";
      if (overlay.isSkinnedMesh) {
        overlay.bindMode = object.bindMode;
        overlay.bind(object.skeleton, object.bindMatrix);
      }
      this.scene.add(overlay);
      this.meshWireOverlays.push(overlay);
      return overlay;
    },

    disposeMeshWireOverlays() {
      for (const overlay of this.meshWireOverlays || []) {
        overlay.parent?.remove(overlay);
      }
      this.meshWireOverlays = [];
    },

    updateMeshWireOverlays() {
      const visible = !this.cleanPreview && Boolean(this.showMeshLayer) && !this.cloneSpotlightActive;
      for (const record of this.paintRecords || []) {
        const overlay = record.wireOverlay;
        if (!overlay) {
          continue;
        }
        overlay.visible = visible;
        if (!visible) {
          continue;
        }
        record.object.updateMatrixWorld(true);
        record.object.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
        overlay.updateMatrixWorld(true);
      }
    },

    cleanPreviewAllowsRigGizmo() {
      return Boolean(this.gizmoOnlyPreview);
    },

    updateGizmoOnlyPreviewButton() {
      if (!this.gizmoOnlyPreviewButton) {
        return;
      }
      const hasGizmo = Boolean(
        this.activeTool === "bone"
        && (
          (this.boneMoveGizmoArmed && this.bones?.has(this.activeBoneName))
          || (this.ikTargetGizmoArmed && (this.ikChainNames?.() || []).length >= 2)
        )
      );
      if (!hasGizmo && this.gizmoOnlyPreview) {
        this.gizmoOnlyPreview = false;
        this.cleanPreview = false;
        this.cleanPreviewButton?.classList.remove("is-active");
        this.cleanPreviewButton?.setAttribute("aria-pressed", "false");
      }
      this.gizmoOnlyPreviewButton.hidden = !hasGizmo;
      this.gizmoOnlyPreviewButton.disabled = !hasGizmo;
      this.gizmoOnlyPreviewButton.classList.toggle("is-active", this.gizmoOnlyPreview);
      this.gizmoOnlyPreviewButton.setAttribute("aria-pressed", String(this.gizmoOnlyPreview));
    },

    setGizmoOnlyPreview(enabled) {
      this.gizmoOnlyPreview = Boolean(enabled);
      if (this.gizmoOnlyPreview) {
        this.cleanPreview = true;
        this.cleanPreviewButton.classList.remove("is-active");
        this.cleanPreviewButton.setAttribute("aria-pressed", "false");
      } else {
        this.cleanPreview = false;
        this.cleanPreviewButton.classList.remove("is-active");
        this.cleanPreviewButton.setAttribute("aria-pressed", "false");
      }
      this.setViewMode(this.viewMode, { silent: true, preserveViewportLayers: true });
      this.updateSelectionMarkers();
      this.updateAllVertexMarkers();
      this.updateMoveGizmo();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
      this.updateSkeletonHelper();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLabels();
      this.updateGizmoOnlyPreviewButton();
      this.setStatus(this.gizmoOnlyPreview ? "Gizmo only preview" : "Selection view restored");
    },

    setCleanPreview(enabled) {
      enabled = Boolean(enabled);
      this.gizmoOnlyPreview = false;
      this.cleanPreview = enabled;
      this.cleanPreviewButton.classList.toggle("is-active", enabled);
      this.cleanPreviewButton.setAttribute("aria-pressed", String(enabled));
      this.cleanPreviewButton.textContent = "Clean Preview";
      this.setViewMode(this.viewMode, { silent: true, preserveViewportLayers: true });
      this.updateSelectionMarkers();
      this.updateAllVertexMarkers();
      this.updateMoveGizmo();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
      this.updateSkeletonHelper();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLabels();
      this.updateGizmoOnlyPreviewButton();
      this.setStatus(enabled ? "Clean preview: overlays hidden" : "Selection view restored");
    },

    setMirrorMode(enabled) {
      this.mirrorMode = enabled;
      this.mirrorModeButton?.classList.toggle("is-active", enabled);
      this.mirrorModeButton?.setAttribute("aria-pressed", String(enabled));
      if (enabled) {
        this.updateManualPoseFromControls({ silent: true });
        this.mirrorCurrentSelection();
      }
      this.populateBoneSelect();
      this.syncPoseControls();
      this.updateTimelineKeyMarkers();
      this.applyPose(this.progress);
      this.syncPatchJson();
      this.setStatus(enabled ? "Mirror mode: paired bones and selections" : "Mirror mode off");
    },

    setPlayback(playing) {
      if (playing) {
        this.stopSequencePreview({ applyPose: false });
        this.discardUnkeyedPosePreview({ status: true });
      }
      this.playing = playing;
      const label = playing ? "Pause" : "Play";
      if (this.playToggle) {
        this.playToggle.textContent = label;
      }
      if (this.timelinePlayToggle) {
        this.timelinePlayToggle.textContent = label;
      }
    },

    async toggleBlendAwarePlayback() {
      if (this.blendActionId && this.actorTarget?.mode !== "bird-flap") {
        if (this.sequencePlaying || this.timelinePlayBothButton?.textContent === "Stop Sequence") {
          this.stopSequencePreview({ applyPose: true, resetElapsed: true });
          return;
        }
        await this.playBothSequence();
        return;
      }
      this.setPlayback(!this.playing);
    },

    stopSequencePreview({ applyPose = false, resetElapsed = false } = {}) {
      if (!this.sequencePlaying && this.timelinePlayBothButton?.textContent !== "Stop Sequence") {
        this.syncSequenceControls();
        return;
      }
      this.sequencePlaying = false;
      if (resetElapsed) {
        this.sequenceElapsed = 0;
      }
      this.sequenceRootAnchor = null;
      this.sequenceTargetRootStart = null;
      if (this.timelinePlayBothButton) {
        this.timelinePlayBothButton.textContent = "Play Sequence";
      }
      if (!this.playing && this.playToggle) {
        this.playToggle.textContent = "Play";
      }
      this.syncSequenceControls();
      if (applyPose) {
        this.applyPose(this.progress);
        this.syncPoseControlsToCurrentBone();
      }
    },

    async playBothSequence() {
      if (!this.blendClipEntry || this.actorTarget?.mode === "bird-flap") {
        this.setStatus("Choose a Blend To animation first");
        return;
      }
      if (!this.blendClipEntry.clip) {
        this.blendClipEntry.clip = await this.loadClipForEntry(this.blendClipEntry);
      }
      if (!this.activeClipEntry?.clip) {
        return;
      }
      this.setPlayback(false);
      this.discardUnkeyedPosePreview({ applyPose: false, syncControls: false });
      this.sequencePlaying = true;
      this.sequenceElapsed = 0;
      this.sequenceRootAnchor = null;
      this.sequenceTargetRootStart = null;
      if (this.timelinePlayBothButton) {
        this.timelinePlayBothButton.textContent = "Stop Sequence";
      }
      if (this.playToggle) {
        this.playToggle.textContent = "Pause";
      }
      this.syncSequenceControls();
      this.setStatus(`Playing sequence: ${this.activeClipEntry.name || this.activeClipEntry.id} -> ${this.blendClipEntry.name || this.blendClipEntry.id}`);
    },

    sidePanelWidthBounds() {
      const viewportWidth = typeof window !== "undefined" ? Number(window.innerWidth) || 0 : 0;
      const viewportMax = viewportWidth > 0 ? Math.max(SIDE_PANEL_MIN_WIDTH, viewportWidth - 360) : SIDE_PANEL_MAX_WIDTH;
      return {
        min: SIDE_PANEL_MIN_WIDTH,
        max: Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, viewportMax))
      };
    },

    clampSidePanelWidth(width, options = {}) {
      const value = Number(width);
      const { min, max } = this.sidePanelWidthBounds();
      const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : min;
      return Math.round(THREE.MathUtils.clamp(Number.isFinite(value) ? value : SIDE_PANEL_DEFAULT_WIDTH, Math.min(minWidth, max), max));
    },

    sidePanelFontSizeForWidth(width) {
      const compactT = THREE.MathUtils.clamp((Number(width) - SIDE_PANEL_MIN_WIDTH) / (SIDE_PANEL_DEFAULT_WIDTH - SIDE_PANEL_MIN_WIDTH), 0, 1);
      return 9.25 + compactT * 2.75;
    },

    applySidePanelWidth(width, options = {}) {
      if (!this.app) {
        return SIDE_PANEL_DEFAULT_WIDTH;
      }
      const nextWidth = this.clampSidePanelWidth(width, options);
      const nextFontSize = this.sidePanelFontSizeForWidth(nextWidth);
      this.app.style.setProperty("--cleanup-side-panel-width", `${nextWidth}px`);
      this.app.style.setProperty("--cleanup-side-panel-font-size", `${nextFontSize.toFixed(2)}px`);
      this.app.classList.toggle("is-side-panel-narrow", nextWidth <= SIDE_PANEL_NARROW_WIDTH);
      this.app.classList.toggle("is-side-panel-tight", nextWidth <= SIDE_PANEL_TIGHT_WIDTH);
      if (options.persist !== false) {
        try {
          window.localStorage?.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
        } catch {
          // Ignore private browsing/storage failures.
        }
      }
      return nextWidth;
    },

    applySidePanelDragOffset(offset = 0) {
      if (!this.app) {
        return;
      }
      const value = Number(offset);
      const nextOffset = Number.isFinite(value) ? Math.round(value) : 0;
      this.app.style.setProperty("--cleanup-side-panel-drag-x", `${nextOffset}px`);
    },

    applyTimelineDrawerDragOffset(offset = 0) {
      if (!this.app) {
        return;
      }
      const value = Number(offset);
      const nextOffset = Number.isFinite(value) ? Math.round(value) : 0;
      this.app.style.setProperty("--cleanup-timeline-drawer-drag-y", `${nextOffset}px`);
    },

    sidePanelSnapBackDistance(width) {
      const panelWidth = Number(width);
      const baseWidth = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : SIDE_PANEL_DEFAULT_WIDTH;
      return Math.max(1, baseWidth * SIDE_PANEL_SNAP_BACK_RATIO);
    },

    timelineDrawerMinimumHeight(startHeight) {
      const drawerHeight = Number(startHeight);
      const baseHeight = Number.isFinite(drawerHeight) && drawerHeight > 0 ? drawerHeight : TIMELINE_DRAWER_SNAP_HEIGHT;
      return Math.max(1, Math.min(baseHeight, this.timelineDrawerCompactHeight()));
    },

    timelineDrawerCloseDistance(startHeight) {
      return Math.max(
        TIMELINE_DRAWER_GESTURE_THRESHOLD,
        this.timelineDrawerMinimumHeight(startHeight) * TIMELINE_DRAWER_CLOSE_RATIO
      );
    },

    restoreSidePanelWidth() {
      let storedWidth = SIDE_PANEL_DEFAULT_WIDTH;
      try {
        const value = window.localStorage?.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY);
        if (value !== null) {
          storedWidth = Number(value);
        }
      } catch {
        storedWidth = SIDE_PANEL_DEFAULT_WIDTH;
      }
      return this.applySidePanelWidth(storedWidth, { persist: false });
    },

    beginSidePanelResize(event) {
      if (!this.app || !this.sidePanelResizeHandle || event.button > 0) {
        return;
      }
      const panelRect = this.sidePanelResizeHandle.closest?.(".viewer-panel")?.getBoundingClientRect();
      this.sidePanelResizeDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panelRect?.width || this.restoreSidePanelWidth(),
        latestDeltaX: 0,
        latestWidth: panelRect?.width || this.restoreSidePanelWidth()
      };
      this.app.classList.add("is-side-panel-resizing");
      this.sidePanelResizeHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },

    beginSidePanelMouseResize(event) {
      if (!this.app || !this.sidePanelResizeHandle || this.sidePanelResizeDrag || event.button > 0) {
        return;
      }
      const panelRect = this.sidePanelResizeHandle.closest?.(".viewer-panel")?.getBoundingClientRect();
      this.sidePanelResizeDrag = {
        mouse: true,
        startX: event.clientX,
        startWidth: panelRect?.width || this.restoreSidePanelWidth(),
        latestDeltaX: 0,
        latestWidth: panelRect?.width || this.restoreSidePanelWidth()
      };
      this.app.classList.add("is-side-panel-resizing");
      this.boundSidePanelMouseMove = this.boundSidePanelMouseMove || ((moveEvent) => this.dragSidePanelMouseResize(moveEvent));
      this.boundSidePanelMouseUp = this.boundSidePanelMouseUp || ((upEvent) => this.endSidePanelMouseResize(upEvent));
      window.addEventListener("mousemove", this.boundSidePanelMouseMove);
      window.addEventListener("mouseup", this.boundSidePanelMouseUp);
      event.preventDefault();
    },

    dragSidePanelResize(event) {
      if (!this.sidePanelResizeDrag || event.pointerId !== this.sidePanelResizeDrag.pointerId) {
        return;
      }
      this.updateSidePanelResizeDrag(event.clientX);
      event.preventDefault();
    },

    endSidePanelResize(event) {
      if (!this.sidePanelResizeDrag || event.pointerId !== this.sidePanelResizeDrag.pointerId) {
        return;
      }
      const drag = this.sidePanelResizeDrag;
      this.sidePanelResizeHandle?.releasePointerCapture?.(event.pointerId);
      this.sidePanelResizeDrag = null;
      this.app?.classList.remove("is-side-panel-resizing");
      this.finishSidePanelResizeDrag(drag);
      event.preventDefault();
    },

    dragSidePanelMouseResize(event) {
      if (!this.sidePanelResizeDrag?.mouse) {
        return;
      }
      this.updateSidePanelResizeDrag(event.clientX);
      event.preventDefault();
    },

    endSidePanelMouseResize(event) {
      if (!this.sidePanelResizeDrag?.mouse) {
        return;
      }
      const drag = this.sidePanelResizeDrag;
      window.removeEventListener("mousemove", this.boundSidePanelMouseMove);
      window.removeEventListener("mouseup", this.boundSidePanelMouseUp);
      this.sidePanelResizeDrag = null;
      this.app?.classList.remove("is-side-panel-resizing");
      this.finishSidePanelResizeDrag(drag);
      event.preventDefault();
    },

    updateSidePanelResizeDrag(clientX) {
      if (!this.sidePanelResizeDrag) {
        return;
      }
      const deltaX = clientX - this.sidePanelResizeDrag.startX;
      const pullingClosed = deltaX < 0;
      const { min } = this.sidePanelWidthBounds();
      const rawWidth = this.sidePanelResizeDrag.startWidth + deltaX;
      const closeDistance = this.sidePanelSnapBackDistance(min);
      const pullPastMinimum = pullingClosed ? Math.max(0, min - rawWidth) : 0;
      const nextWidth = pullingClosed ? Math.max(rawWidth, min) : rawWidth;
      const dragOffset = pullPastMinimum > 0
        ? -Math.min(pullPastMinimum, closeDistance) * SIDE_PANEL_ELASTIC_RESISTANCE
        : 0;
      this.sidePanelResizeDrag.latestDeltaX = deltaX;
      this.sidePanelResizeDrag.latestPullPastMinimum = pullPastMinimum;
      this.sidePanelResizeDrag.latestWidth = this.applySidePanelWidth(nextWidth, {
        persist: false
      });
      this.applySidePanelDragOffset(dragOffset);
      this.app?.classList.toggle("is-side-panel-snap-ready", pullPastMinimum >= closeDistance);
      this.resize?.();
    },

    finishSidePanelResizeDrag(drag) {
      this.app?.classList.remove("is-side-panel-snap-ready");
      const closeDistance = this.sidePanelSnapBackDistance(this.sidePanelWidthBounds().min);
      const pullPastMinimum = Number(drag?.latestPullPastMinimum) || 0;
      if (pullPastMinimum >= closeDistance) {
        this.applySidePanelWidth(this.sidePanelWidthBounds().min, { persist: false });
        this.hideSidePanelDrawer({ slideWidth: drag.startWidth });
      } else {
        this.applySidePanelDragOffset(0);
        this.applySidePanelWidth(drag?.latestWidth ?? drag?.startWidth ?? SIDE_PANEL_DEFAULT_WIDTH);
        this.resize?.();
      }
    },

    adjustSidePanelWidth(delta) {
      const panelRect = this.sidePanelResizeHandle?.closest?.(".viewer-panel")?.getBoundingClientRect();
      const currentWidth = panelRect?.width || this.restoreSidePanelWidth();
      this.applySidePanelWidth(currentWidth + delta);
      this.resize?.();
    },

    handleSidePanelResizeKey(event) {
      if (event.key === "ArrowLeft") {
        this.adjustSidePanelWidth(event.shiftKey ? -24 : -12);
      } else if (event.key === "ArrowRight") {
        this.adjustSidePanelWidth(event.shiftKey ? 24 : 12);
      } else if (event.key === "Home") {
        this.applySidePanelWidth(SIDE_PANEL_MIN_WIDTH);
        this.resize?.();
      } else if (event.key === "End") {
        this.applySidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH);
        this.resize?.();
      } else {
        return;
      }
      event.preventDefault();
    },

    resetSidePanelWidth() {
      this.applySidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH);
      this.resize?.();
    },

    beginSidePanelHiddenDrag(event) {
      if (!this.app || this.app.classList.contains("is-side-panel-open") || event.button > 0) {
        return;
      }
      this.sidePanelHiddenDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        latestDeltaX: 0,
        openedDuringDrag: false
      };
      this.boundSidePanelHiddenPointerMove = this.boundSidePanelHiddenPointerMove
        || ((moveEvent) => this.dragSidePanelHiddenDrag(moveEvent));
      this.boundSidePanelHiddenPointerUp = this.boundSidePanelHiddenPointerUp
        || ((upEvent) => this.endSidePanelHiddenDrag(upEvent));
      window.addEventListener("pointermove", this.boundSidePanelHiddenPointerMove);
      window.addEventListener("pointerup", this.boundSidePanelHiddenPointerUp);
      window.addEventListener("pointercancel", this.boundSidePanelHiddenPointerUp);
      this.sidePanelShowToggle?.setPointerCapture?.(event.pointerId);
      event.stopPropagation?.();
      event.preventDefault();
    },

    dragSidePanelHiddenDrag(event) {
      if (!this.sidePanelHiddenDrag || event.pointerId !== this.sidePanelHiddenDrag.pointerId) {
        return;
      }
      const deltaX = event.clientX - this.sidePanelHiddenDrag.startX;
      this.sidePanelHiddenDrag.latestDeltaX = deltaX;
      if (deltaX >= SIDE_PANEL_EDGE_GESTURE_THRESHOLD) {
        this.sidePanelHiddenDrag.openedDuringDrag = true;
        this.showSidePanelDrawer();
      }
      event.preventDefault();
    },

    endSidePanelHiddenDrag(event) {
      if (!this.sidePanelHiddenDrag || event.pointerId !== this.sidePanelHiddenDrag.pointerId) {
        return;
      }
      this.sidePanelShowToggle?.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", this.boundSidePanelHiddenPointerMove);
      window.removeEventListener("pointerup", this.boundSidePanelHiddenPointerUp);
      window.removeEventListener("pointercancel", this.boundSidePanelHiddenPointerUp);
      const opened = this.sidePanelHiddenDrag.openedDuringDrag;
      const deltaX = Math.abs(Number(this.sidePanelHiddenDrag.latestDeltaX) || 0);
      this.sidePanelHiddenDrag = null;
      if (!opened && deltaX < SIDE_PANEL_EDGE_GESTURE_THRESHOLD) {
        this.showSidePanelDrawer();
      }
      event.preventDefault();
    },

    showSidePanelDrawer() {
      if (!this.app) {
        return;
      }
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      const wasOpen = this.app.classList.contains("is-side-panel-open");
      if (wasOpen) {
        window.clearTimeout?.(this.sidePanelHideTimer);
        this.sidePanelHideTimer = null;
        window.cancelAnimationFrame?.(this.sidePanelOpenFrame);
        this.sidePanelOpenFrame = null;
        this.app.classList.remove("is-side-panel-opening", "is-side-panel-closing");
        this.resize?.();
        return;
      }
      window.clearTimeout?.(this.sidePanelHideTimer);
      this.sidePanelHideTimer = null;
      window.cancelAnimationFrame?.(this.sidePanelOpenFrame);
      this.sidePanelOpenFrame = null;
      this.applySidePanelDragOffset(0);
      this.app.classList.remove("is-side-panel-closing");
      if (!reduceMotion) {
        this.app.classList.add("is-side-panel-opening");
      }
      this.setSidePanelOpen(true, { preserveAnimationClass: !reduceMotion });
      if (!reduceMotion) {
        this.sidePanelShowToggle?.getBoundingClientRect?.();
        this.sidePanelOpenFrame = window.requestAnimationFrame?.(() => {
          this.sidePanelOpenFrame = window.requestAnimationFrame?.(() => {
            this.sidePanelOpenFrame = null;
            this.app?.classList.remove("is-side-panel-opening");
          });
        });
      }
    },

    hideSidePanelDrawer(options = {}) {
      if (!this.app || !this.app.classList.contains("is-side-panel-open")) {
        return;
      }
      window.clearTimeout?.(this.sidePanelHideTimer);
      window.cancelAnimationFrame?.(this.sidePanelOpenFrame);
      this.applySidePanelDragOffset(0);
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      if (reduceMotion) {
        this.setSidePanelOpen(false);
        return;
      }
      this.app.classList.remove("is-side-panel-resizing", "is-side-panel-opening");
      const panelRect = this.sidePanelResizeHandle?.closest?.(".viewer-panel")?.getBoundingClientRect();
      const slideWidth = Number(options.slideWidth) || panelRect?.width || this.restoreSidePanelWidth?.() || SIDE_PANEL_DEFAULT_WIDTH;
      this.app.classList.add("is-side-panel-closing");
      this.applySidePanelDragOffset(-(slideWidth + 12));
      this.sidePanelHideTimer = window.setTimeout(() => {
        this.sidePanelHideTimer = null;
        this.applySidePanelDragOffset(0);
        this.setSidePanelOpen(false);
      }, SIDE_PANEL_TRANSITION_MS);
    },

    timelineDrawerHeightBounds() {
      const viewportHeight = typeof window !== "undefined" ? Number(window.innerHeight) || 0 : 0;
      const maxByViewport = viewportHeight > 0
        ? Math.max(TIMELINE_DRAWER_MIN_HEIGHT, viewportHeight - 2)
        : TIMELINE_DRAWER_MAX_HEIGHT;
      return {
        min: TIMELINE_DRAWER_MIN_HEIGHT,
        snap: TIMELINE_DRAWER_SNAP_HEIGHT,
        max: maxByViewport
      };
    },

    timelineDrawerHasCurveContent() {
      return Boolean(this.boneLayerNames?.length);
    },

    timelineDrawerCompactHeight() {
      const panel = this.timelineDrawerPanel?.();
      if (!panel) {
        return TIMELINE_DRAWER_SNAP_HEIGHT;
      }
      const styles = window.getComputedStyle?.(panel);
      const paddingTop = Number.parseFloat(styles?.paddingTop || "0") || 0;
      const paddingBottom = Number.parseFloat(styles?.paddingBottom || "0") || 0;
      const borderTop = Number.parseFloat(styles?.borderTopWidth || "0") || 0;
      const borderBottom = Number.parseFloat(styles?.borderBottomWidth || "0") || 0;
      const gap = Number.parseFloat(styles?.rowGap || styles?.gap || "0") || 0;
      const rows = [...panel.children].filter((child) => {
        if (child === this.timelineDrawerHandle || child === this.boneLayerList) {
          return false;
        }
        const rowStyles = window.getComputedStyle?.(child);
        return rowStyles?.display !== "none";
      });
      const rowHeight = rows.reduce((total, row) => total + row.getBoundingClientRect().height, 0);
      return Math.max(1, Math.ceil(paddingTop + paddingBottom + borderTop + borderBottom + rowHeight + Math.max(0, rows.length - 1) * gap));
    },

    timelineDrawerContentHeight() {
      if (!this.timelineDrawerHasCurveContent() || !this.boneLayerList?.children?.length) {
        return 0;
      }
      const panel = this.boneLayerList.closest?.(".weight-timeline-panel");
      if (!panel) {
        return 0;
      }
      const styles = window.getComputedStyle?.(panel);
      const listStyles = window.getComputedStyle?.(this.boneLayerList);
      const paddingBottom = Number.parseFloat(styles?.paddingBottom || "0") || 0;
      const borderBottom = Number.parseFloat(styles?.borderBottomWidth || "0") || 0;
      const listPaddingTop = Number.parseFloat(listStyles?.paddingTop || "0") || 0;
      const listPaddingBottom = Number.parseFloat(listStyles?.paddingBottom || "0") || 0;
      const listGap = Number.parseFloat(listStyles?.rowGap || listStyles?.gap || "0") || 0;
      const rows = [...this.boneLayerList.children];
      const rowsHeight = rows.reduce((total, row) => total + row.getBoundingClientRect().height, 0)
        + Math.max(0, rows.length - 1) * listGap
        + listPaddingTop
        + listPaddingBottom;
      const contentHeight = this.boneLayerList.offsetTop + rowsHeight + paddingBottom + borderBottom;
      const { max } = this.timelineDrawerHeightBounds();
      return Math.max(0, Math.min(max, Math.ceil(contentHeight)));
    },

    defaultTimelineDrawerHeight() {
      const viewportHeight = typeof window !== "undefined" ? Number(window.innerHeight) || 0 : 0;
      const preferred = viewportHeight > 0 ? Math.min(TIMELINE_DRAWER_DEFAULT_HEIGHT, viewportHeight * 0.72) : TIMELINE_DRAWER_DEFAULT_HEIGHT;
      return this.clampTimelineDrawerHeight(Math.max(TIMELINE_DRAWER_MIN_HEIGHT, preferred));
    },

    clampTimelineDrawerHeight(height, options = {}) {
      const value = Number(height);
      const { min, max } = this.timelineDrawerHeightBounds();
      const contentHeight = options.fitContent !== false ? this.timelineDrawerContentHeight() : 0;
      const effectiveMax = contentHeight > 0 ? Math.min(max, contentHeight) : max;
      const requestedMin = Number(options.minHeight);
      const baseMin = Number.isFinite(requestedMin) ? requestedMin : min;
      const effectiveMin = Math.min(baseMin, effectiveMax);
      return Math.round(THREE.MathUtils.clamp(Number.isFinite(value) ? value : this.defaultTimelineDrawerHeight(), effectiveMin, effectiveMax));
    },

    applyTimelineDrawerHeight(height, options = {}) {
      if (!this.app) {
        return TIMELINE_DRAWER_DEFAULT_HEIGHT;
      }
      const nextHeight = this.clampTimelineDrawerHeight(height, options);
      if (options.userSized === true) {
        this.timelineDrawerUserSized = true;
      }
      this.app.style.setProperty("--cleanup-timeline-drawer-height", `${nextHeight}px`);
      if (options.persist !== false) {
        try {
          window.localStorage?.setItem(TIMELINE_DRAWER_HEIGHT_STORAGE_KEY, String(nextHeight));
        } catch {
          // Ignore private browsing/storage failures.
        }
      }
      return nextHeight;
    },

    restoreTimelineDrawerHeight() {
      let storedHeight = this.defaultTimelineDrawerHeight();
      try {
        const value = window.localStorage?.getItem(TIMELINE_DRAWER_HEIGHT_STORAGE_KEY);
        if (value !== null) {
          storedHeight = Number(value);
        }
      } catch {
        storedHeight = this.defaultTimelineDrawerHeight();
      }
      return this.applyTimelineDrawerHeight(Math.max(storedHeight, this.defaultTimelineDrawerHeight()), { persist: false });
    },

    fitTimelineDrawerToContent(options = {}) {
      if (!this.app || this.app.classList.contains("is-timeline-compact")) {
        return 0;
      }
      if (this.timelineDrawerUserSized && options.force !== true) {
        return this.timelineDrawerPanel?.()?.getBoundingClientRect?.()?.height || 0;
      }
      if (!this.timelineDrawerHasCurveContent()) {
        this.setTimelineCompact(true, { status: false });
        return 0;
      }
      const contentHeight = this.timelineDrawerContentHeight();
      if (contentHeight <= 0) {
        return 0;
      }
      return this.applyTimelineDrawerHeight(contentHeight, {
        persist: options.persist === true,
        fitContent: true
      });
    },

    beginTimelineDrawerDrag(event) {
      if (!this.app || this.timelineDrawerDrag || event.button > 0) {
        return;
      }
      const panelRect = this.timelineDrawerPanel()?.getBoundingClientRect();
      const captureElement = event.currentTarget?.setPointerCapture ? event.currentTarget : this.timelineDrawerHandle;
      this.timelineDrawerDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: panelRect?.height || this.defaultTimelineDrawerHeight(),
        latestHeight: panelRect?.height || this.defaultTimelineDrawerHeight(),
        latestDeltaY: 0,
        startCompact: this.app.classList.contains("is-timeline-compact"),
        captureElement
      };
      this.app.classList.add("is-timeline-drawer-dragging");
      this.boundTimelineDrawerPointerMove = this.boundTimelineDrawerPointerMove || ((moveEvent) => this.dragTimelineDrawer(moveEvent));
      this.boundTimelineDrawerPointerUp = this.boundTimelineDrawerPointerUp || ((upEvent) => this.endTimelineDrawerDrag(upEvent));
      window.addEventListener("pointermove", this.boundTimelineDrawerPointerMove);
      window.addEventListener("pointerup", this.boundTimelineDrawerPointerUp);
      window.addEventListener("pointercancel", this.boundTimelineDrawerPointerUp);
      captureElement?.setPointerCapture?.(event.pointerId);
      event.stopPropagation?.();
      event.preventDefault();
    },

    dragTimelineDrawer(event) {
      if (!this.timelineDrawerDrag || event.pointerId !== this.timelineDrawerDrag.pointerId) {
        return;
      }
      if (this.timelineDrawerDrag.closedDuringDrag) {
        event.preventDefault();
        return;
      }
      const deltaY = event.clientY - this.timelineDrawerDrag.startY;
      const isCompact = this.app?.classList.contains("is-timeline-compact");
      const rawHeight = this.timelineDrawerDrag.startHeight - deltaY;
      const dragMinHeight = this.timelineDrawerMinimumHeight(this.timelineDrawerDrag.startHeight);
      const closeDistance = this.timelineDrawerCloseDistance(this.timelineDrawerDrag.startHeight);
      const pullPastMinimum = Math.max(0, dragMinHeight - rawHeight);
      const nextHeight = this.clampTimelineDrawerHeight(rawHeight, {
        fitContent: false,
        minHeight: dragMinHeight
      });
      const dragOffset = pullPastMinimum > 0
        ? Math.min(pullPastMinimum, closeDistance) * TIMELINE_DRAWER_ELASTIC_RESISTANCE
        : 0;
      this.timelineDrawerDrag.latestHeight = nextHeight;
      this.timelineDrawerDrag.latestDeltaY = deltaY;
      this.timelineDrawerDrag.latestPullPastMinimum = pullPastMinimum;
      this.applyTimelineDrawerDragOffset(dragOffset);
      if (isCompact) {
        if (deltaY > 0) {
          event.preventDefault();
          return;
        }
        if (deltaY < 0) {
          this.setTimelineCompact(false, {
            height: nextHeight,
            fitContent: false,
            minHeight: dragMinHeight,
            persist: false,
            userSized: true
          });
        }
      } else {
        this.applyTimelineDrawerHeight(nextHeight, {
          persist: false,
          fitContent: false,
          minHeight: dragMinHeight,
          userSized: true
        });
      }
      this.resize?.();
      event.preventDefault();
    },

    beginTimelineHiddenDrawerDrag(event) {
      if (!this.app || event.button > 0) {
        return;
      }
      this.timelineHiddenDrawerDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        openedDuringDrag: false
      };
      this.boundTimelineHiddenDrawerPointerMove = this.boundTimelineHiddenDrawerPointerMove
        || ((moveEvent) => this.dragTimelineHiddenDrawer(moveEvent));
      this.boundTimelineHiddenDrawerPointerUp = this.boundTimelineHiddenDrawerPointerUp
        || ((upEvent) => this.endTimelineHiddenDrawerDrag(upEvent));
      window.addEventListener("pointermove", this.boundTimelineHiddenDrawerPointerMove);
      window.addEventListener("pointerup", this.boundTimelineHiddenDrawerPointerUp);
      window.addEventListener("pointercancel", this.boundTimelineHiddenDrawerPointerUp);
      this.timelineShowToggle?.setPointerCapture?.(event.pointerId);
      event.stopPropagation?.();
      event.preventDefault();
    },

    dragTimelineHiddenDrawer(event) {
      if (!this.timelineHiddenDrawerDrag || event.pointerId !== this.timelineHiddenDrawerDrag.pointerId) {
        return;
      }
      const deltaY = event.clientY - this.timelineHiddenDrawerDrag.startY;
      if (deltaY < 0) {
        const nextHeight = this.clampTimelineDrawerHeight(-deltaY, {
          fitContent: false,
          minHeight: 1
        });
        this.timelineHiddenDrawerDrag.openedDuringDrag = true;
        this.setTimelineHidden(false);
        this.setTimelineCompact(false, {
          height: nextHeight,
          fitContent: false,
          minHeight: 1,
          persist: false,
          status: false,
          userSized: true
        });
      }
      event.preventDefault();
    },

    endTimelineHiddenDrawerDrag(event) {
      if (!this.timelineHiddenDrawerDrag || event.pointerId !== this.timelineHiddenDrawerDrag.pointerId) {
        return;
      }
      this.timelineShowToggle?.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", this.boundTimelineHiddenDrawerPointerMove);
      window.removeEventListener("pointerup", this.boundTimelineHiddenDrawerPointerUp);
      window.removeEventListener("pointercancel", this.boundTimelineHiddenDrawerPointerUp);
      const opened = this.timelineHiddenDrawerDrag.openedDuringDrag;
      this.timelineHiddenDrawerDrag = null;
      if (!opened) {
        this.hideTimelineDrawer();
      }
      event.preventDefault();
    },

    endTimelineDrawerDrag(event) {
      if (!this.timelineDrawerDrag || event.pointerId !== this.timelineDrawerDrag.pointerId) {
        return;
      }
      const latestHeight = this.timelineDrawerDrag.latestHeight;
      const latestDeltaY = this.timelineDrawerDrag.latestDeltaY || 0;
      const startCompact = this.timelineDrawerDrag.startCompact === true;
      const startHeight = this.timelineDrawerDrag.startHeight;
      const minHeight = this.timelineDrawerMinimumHeight(startHeight);
      const closeDistance = this.timelineDrawerCloseDistance(startHeight);
      const pullPastMinimum = Number(this.timelineDrawerDrag.latestPullPastMinimum) || 0;
      this.timelineDrawerDrag.captureElement?.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", this.boundTimelineDrawerPointerMove);
      window.removeEventListener("pointerup", this.boundTimelineDrawerPointerUp);
      window.removeEventListener("pointercancel", this.boundTimelineDrawerPointerUp);
      const closedDuringDrag = this.timelineDrawerDrag.closedDuringDrag === true;
      this.timelineDrawerDrag = null;
      this.app?.classList.remove("is-timeline-drawer-dragging");
      if (closedDuringDrag) {
        event.preventDefault();
        return;
      }
      if (pullPastMinimum >= closeDistance) {
        this.applyTimelineDrawerHeight(minHeight, {
          fitContent: false,
          minHeight,
          persist: false,
          userSized: true
        });
        this.applyTimelineDrawerDragOffset(0);
        this.setTimelineCompact(true, { status: false });
        this.hideTimelineDrawer();
      } else if (pullPastMinimum > 0) {
        this.applyTimelineDrawerDragOffset(0);
        this.setTimelineCompact(true, { status: false });
        this.resize?.();
      } else if (startCompact) {
        this.applyTimelineDrawerDragOffset(0);
        if (latestDeltaY < 0) {
          this.setTimelineCompact(false, { height: latestHeight, fitContent: false, minHeight, userSized: true });
        } else {
          this.setTimelineCompact(true);
        }
        this.resize?.();
      } else {
        this.applyTimelineDrawerDragOffset(0);
        this.applyTimelineDrawerHeight(latestHeight, { fitContent: false, minHeight, userSized: true });
        this.resize?.();
      }
      event.preventDefault();
    },

    adjustTimelineDrawerHeight(delta) {
      const compact = this.app?.classList.contains("is-timeline-compact");
      const panelRect = this.timelineDrawerHandle?.closest?.(".weight-timeline-panel")?.getBoundingClientRect();
      const currentHeight = compact ? this.timelineDrawerHeightBounds().snap : panelRect?.height || this.restoreTimelineDrawerHeight();
      const minHeight = this.timelineDrawerMinimumHeight(currentHeight);
      const nextHeight = this.clampTimelineDrawerHeight(currentHeight + delta, {
        fitContent: false,
        minHeight
      });
      if (compact && delta <= 0) {
        this.setTimelineCompact(true);
        return;
      }
      this.setTimelineCompact(false, { height: nextHeight, fitContent: false, minHeight, userSized: true });
    },

    handleTimelineDrawerKey(event) {
      if (event.key === "ArrowUp") {
        this.adjustTimelineDrawerHeight(event.shiftKey ? 72 : 36);
      } else if (event.key === "ArrowDown") {
        this.adjustTimelineDrawerHeight(event.shiftKey ? -72 : -36);
      } else if (event.key === "Home") {
        this.setTimelineCompact(true);
      } else if (event.key === "End") {
        this.setTimelineCompact(false, { height: this.defaultTimelineDrawerHeight() });
      } else {
        return;
      }
      event.preventDefault();
    },

    resetTimelineDrawerHeight() {
      this.timelineDrawerUserSized = false;
      this.setTimelineCompact(false, { height: this.defaultTimelineDrawerHeight(), fitContent: true });
    },

    timelineDrawerPanel() {
      return this.timelineDrawerHandle?.closest?.(".weight-timeline-panel")
        || document.querySelector(".weight-timeline-panel");
    },

    beginTimelineDrawerEdgeDrag(event) {
      if (event.target === this.timelineDrawerHandle || this.timelineDrawerDrag) {
        return;
      }
      const rect = this.timelineDrawerPanel()?.getBoundingClientRect?.();
      if (!rect || event.clientY - rect.top > TIMELINE_DRAWER_EDGE_GRAB_HEIGHT) {
        return;
      }
      if (event.target?.closest?.("button, input, select, textarea, label")) {
        return;
      }
      this.beginTimelineDrawerDrag(event);
    },

    beginTimelineGlobalEdgeDrag(event) {
      if (!this.app || event.defaultPrevented || this.timelineDrawerDrag || this.timelineHiddenDrawerDrag || event.button > 0) {
        return;
      }
      const edgeHeight = TIMELINE_DRAWER_EDGE_GRAB_HEIGHT;
      if (this.app.classList.contains("is-timeline-hidden")) {
        const viewportHeight = Number(window.innerHeight) || 0;
        if (viewportHeight > 0 && viewportHeight - event.clientY <= edgeHeight) {
          this.beginTimelineHiddenDrawerDrag(event);
        }
        return;
      }
      const panel = this.timelineDrawerPanel?.();
      const rect = panel?.getBoundingClientRect?.();
      if (!rect || event.clientX < rect.left || event.clientX > rect.right) {
        return;
      }
      const onTopEdge = event.clientY >= rect.top - 8 && event.clientY <= rect.top + edgeHeight;
      if (!onTopEdge) {
        return;
      }
      const target = event.target;
      const isHandle = target === this.timelineDrawerHandle;
      const isCompactLayout = window.matchMedia?.("(max-width: 480px)")?.matches === true;
      const isInteractiveTarget = target?.closest?.("button, input, select, textarea, label");
      if (!isHandle && isInteractiveTarget && !isCompactLayout && event.clientY > rect.top + 8) {
        return;
      }
      this.beginTimelineDrawerDrag(event);
    },

    hideTimelineDrawer() {
      if (!this.app || this.app.classList.contains("is-timeline-hidden")) {
        return;
      }
      window.clearTimeout?.(this.timelineDrawerHideTimer);
      this.applyTimelineDrawerDragOffset(0);
      const panel = this.timelineDrawerPanel?.();
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      if (!panel || reduceMotion) {
        this.setTimelineHidden(true);
        return;
      }
      this.app.classList.remove("is-timeline-drawer-dragging");
      this.app.classList.add("is-timeline-closing");
      this.timelineDrawerHideTimer = window.setTimeout(() => {
        this.timelineDrawerHideTimer = null;
        this.setTimelineHidden(true);
      }, TIMELINE_DRAWER_CLOSE_MS);
    },

    setSidePanelOpen(open, options = {}) {
      if (!this.app || !this.sidePanelToggle) {
        return;
      }
      if (!open) {
        window.clearTimeout?.(this.sidePanelHideTimer);
        this.sidePanelHideTimer = null;
        window.cancelAnimationFrame?.(this.sidePanelOpenFrame);
        this.sidePanelOpenFrame = null;
        this.applySidePanelDragOffset(0);
      }
      if (open) {
        this.restoreSidePanelWidth();
      }
      this.app.classList.toggle("is-side-panel-open", open);
      if (options.preserveAnimationClass !== true) {
        this.app.classList.remove("is-side-panel-opening", "is-side-panel-closing", "is-side-panel-snap-ready");
      }
      this.sidePanelToggle.textContent = "";
      this.sidePanelToggle.setAttribute("aria-label", "Hide panel");
      this.sidePanelToggle.title = "Hide panel";
      this.sidePanelToggle.setAttribute("aria-pressed", String(open));
      if (this.sidePanelShowToggle) {
        this.sidePanelShowToggle.hidden = open;
        this.sidePanelShowToggle.setAttribute("aria-pressed", String(open));
      }
      this.resize();
    },

    setTimelineCompact(compact, options = {}) {
      if (!this.app || !this.timelineCompactToggle) {
        return;
      }
      if (!compact && !this.timelineDrawerHasCurveContent()) {
        compact = true;
        if (options.status !== false) {
          this.setStatus?.("Load a character with bones to open curve layers");
        }
      }
      if (!compact) {
        this.applyTimelineDrawerHeight?.(
          options.height ?? this.restoreTimelineDrawerHeight?.() ?? this.defaultTimelineDrawerHeight?.(),
          {
            persist: options.persist !== false,
            fitContent: options.fitContent !== false,
            minHeight: options.minHeight,
            userSized: options.userSized === true
          }
        );
      }
      this.app.classList.toggle("is-timeline-compact", compact);
      this.timelineCompactToggle.textContent = "";
      this.timelineCompactToggle.setAttribute("aria-label", compact ? "Expand timeline" : "Compact timeline");
      this.timelineCompactToggle.title = compact ? "Expand timeline" : "Compact timeline";
      this.timelineCompactToggle.setAttribute("aria-pressed", String(compact));
      if (!compact) {
        if (!this.expandedBoneName && this.boneLayerNames?.length) {
          this.expandedBoneName = this.poseBoneSelect?.value || this.boneLayerNames[0];
        }
        this.updateBoneLayerList?.();
        requestAnimationFrame(() => {
          if (options.fitContent !== false) {
            this.fitTimelineDrawerToContent?.({ persist: false });
          }
          if (options.userSized !== true) {
            this.boneLayerList?.querySelector?.(".bone-layer-row.is-expanded")?.scrollIntoView?.({ block: "nearest" });
          }
          this.drawCurveEditor?.();
          this.updateCurvePlayhead?.();
        });
      }
      this.resize();
    },

    setTimelineHidden(hidden) {
      if (!this.app || !this.timelineShowToggle || !this.timelineHideToggle) {
        return;
      }
      const wasHidden = this.app.classList.contains("is-timeline-hidden");
      const opening = !hidden && wasHidden;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      if (!hidden) {
        window.clearTimeout?.(this.timelineDrawerHideTimer);
        this.timelineDrawerHideTimer = null;
        this.applyTimelineDrawerDragOffset(0);
      }
      window.cancelAnimationFrame?.(this.timelineDrawerOpenFrame);
      if (opening && !reduceMotion) {
        this.app.classList.add("is-timeline-opening");
      } else {
        this.app.classList.remove("is-timeline-opening");
      }
      this.app.classList.toggle("is-timeline-hidden", hidden);
      this.app.classList.remove("is-timeline-closing");
      this.timelineShowToggle.hidden = !hidden;
      this.timelineShowToggle.textContent = "";
      this.timelineShowToggle.setAttribute("aria-label", "Show timeline");
      this.timelineShowToggle.title = "Show timeline";
      this.timelineHideToggle.textContent = "";
      this.timelineHideToggle.setAttribute("aria-label", "Hide timeline");
      this.timelineHideToggle.title = "Hide timeline";
      this.timelineHideToggle.setAttribute("aria-pressed", String(hidden));
      if (opening && !reduceMotion) {
        this.timelineDrawerPanel?.()?.getBoundingClientRect?.();
        this.timelineDrawerOpenFrame = window.requestAnimationFrame?.(() => {
          this.timelineDrawerOpenFrame = null;
          this.app?.classList.remove("is-timeline-opening");
        });
      }
      if (!hidden) {
        this.updateBoneLayerValues({ force: true });
      }
      this.resize();
    },

    setRigPanelOpen(open) {
      this.setPanelSectionOpen(this.rigPanel, open);
    },

    pausePlayback() {
      this.setPlayback(false);
    },

    updateRangeOutputs() {
      if (this.brushRadiusOutput && this.brushRadius) {
        this.brushRadiusOutput.textContent = Number(this.brushRadius.value).toFixed(3);
      }
      if (this.sculptStrengthOutput) {
        this.sculptStrengthOutput.textContent = Number(this.sculptStrength.value).toFixed(4);
      }
      if (this.moveSensitivityOutput) {
        this.moveSensitivityOutput.textContent = Number(this.moveSensitivity.value).toFixed(2);
      }
      if (this.textureBrushRadiusOutput && this.textureBrushRadius) {
        const pixels = typeof this.textureBrushRadiusScreenPixels === "function"
          ? this.textureBrushRadiusScreenPixels()
          : Math.max(1, Number(this.textureBrushRadius.value || 0.035) * 220);
        this.textureBrushRadiusOutput.textContent = `${Math.round(pixels)}px`;
      }
      if (this.textureBrushOpacityOutput && this.textureBrushOpacity) {
        this.textureBrushOpacityOutput.textContent = `${Math.round(Number(this.textureBrushOpacity.value) * 100)}%`;
      }
      if (this.textureBrushHardnessOutput && this.textureBrushHardness) {
        this.textureBrushHardnessOutput.textContent = `${Math.round(Number(this.textureBrushHardness.value) * 100)}%`;
      }
      if (this.textureBrushScatterOutput && this.textureBrushScatter) {
        this.textureBrushScatterOutput.textContent = `${Math.round(Number(this.textureBrushScatter.value) * 100)}%`;
      }
      if (this.cameraGizmoSpeedOutput && this.cameraGizmoSpeed) {
        this.cameraGizmoSpeedOutput.textContent = Number(this.cameraGizmoSpeed.value).toFixed(4);
      }
      if (this.solvedKeyDetailOutput && this.solvedKeyDetail) {
        const detail = this.solvedKeyDetailValue?.() ?? (Number(this.solvedKeyDetail.value) || 0);
        this.solvedKeyDetailOutput.textContent = detail >= 0.995 ? "Full" : `${Math.round(detail * 100)}%`;
      }
      if (this.cameraAmbientLightOutput && this.cameraAmbientLight) {
        this.cameraAmbientLightOutput.textContent = Number(this.cameraAmbientLight.value).toFixed(2);
      }
      if (this.cameraKeyLightOutput && this.cameraKeyLight) {
        this.cameraKeyLightOutput.textContent = Number(this.cameraKeyLight.value).toFixed(2);
      }
      if (this.cameraRimLightOutput && this.cameraRimLight) {
        this.cameraRimLightOutput.textContent = Number(this.cameraRimLight.value).toFixed(2);
      }
      if (this.cameraTextureGainOutput && this.cameraTextureGain) {
        this.cameraTextureGainOutput.textContent = Number(this.cameraTextureGain.value).toFixed(2);
      }
      if (this.speedOutput && this.speedControl) {
        this.speedOutput.textContent = Number(this.speedControl.value).toFixed(2);
      }
    }
  });
}
