export function installPoseCoreMethods(BirdWeightEditor, deps) {
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
  Object.assign(BirdWeightEditor.prototype, {
    resetPose() {
      this.bindPose.forEach(({ object, position, quaternion, scale }) => {
        object.position.copy(position);
        object.quaternion.copy(quaternion);
        object.scale.copy(scale);
      });
    },

    setBoneEuler(name, x, y, z) {
      const bone = this.bones.get(name);
      if (!bone) {
        return;
      }
      const rest = this.bindPose.find((entry) => entry.object === bone);
      if (!rest) {
        return;
      }
      bone.quaternion.copy(rest.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ")));
    },

    addBoneEuler(name, x, y, z) {
      const bone = this.bones.get(name);
      if (!bone) {
        return;
      }
      bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ")));
    },

    addBonePosition(name, x, y, z) {
      const bone = this.bones.get(name);
      if (!bone) {
        return;
      }
      bone.position.x += x || 0;
      bone.position.y += y || 0;
      bone.position.z += z || 0;
    },

    setBoneLayerPose(name, pose) {
      const bone = this.bones.get(name);
      if (!bone) {
        return;
      }
      const rest = this.bindPose.find((entry) => entry.object === bone);
      if (!rest) {
        return;
      }
      bone.quaternion.copy(rest.quaternion).multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.x || 0, pose.y || 0, pose.z || 0, "XYZ"))
      );
      bone.position.set(
        rest.position.x + (pose.px || 0),
        rest.position.y + (pose.py || 0),
        rest.position.z + (pose.pz || 0)
      );
    },

    mirrorBoneName(name) {
      if (String(name).includes("Left")) {
        return String(name).replace("Left", "Right");
      }
      if (String(name).includes("Right")) {
        return String(name).replace("Right", "Left");
      }
      return "";
    },

    canonicalMirrorBone(name) {
      if (!this.mirrorMode || !String(name || "").includes("Right")) {
        return name;
      }
      const leftName = this.mirrorBoneName(name);
      return this.bones.has(leftName) ? leftName : name;
    },

    boneDisplayName(name) {
      const cleanName = String(name || "")
        .replace(/^mixamorig[:_]?/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .replace(/\bFore Arm\b/g, "Forearm")
        .trim() || "Bone";
      if (this.mirrorMode && this.isMirrorableBone(name)) {
        return cleanName.replace(/^(Left|Right)\s*/, "");
      }
      return cleanName;
    },

    rigBoneSearchName(name) {
      return `${name} ${this.boneDisplayName(name)}`.toLowerCase();
    },

    rigBoneGroupForName(name) {
      const search = this.rigBoneSearchName(name);
      return RIG_BONE_GROUPS.find((group) => group.id !== "all" && group.pattern.test(search)) || RIG_BONE_GROUPS[0];
    },

    filteredRigBoneNames() {
      const query = this.rigBoneSearchText || "";
      const activeGroup = RIG_BONE_GROUPS.find((group) => group.id === this.rigBoneGroup) || RIG_BONE_GROUPS[0];
      return this.boneLayerNames.filter((name) => {
        const search = this.rigBoneSearchName(name);
        return (activeGroup.id === "all" || activeGroup.pattern.test(search)) && (!query || search.includes(query));
      });
    },

    updateRigBoneList() {
      if (!this.rigBoneList || !this.rigBoneGroups) {
        return;
      }
      for (const button of this.rigBoneGroups.querySelectorAll("[data-rig-bone-group]")) {
        button.setAttribute("aria-pressed", String((button.dataset.rigBoneGroup || "all") === this.rigBoneGroup));
      }
      const names = this.filteredRigBoneNames();
      if (!names.length) {
        const empty = document.createElement("p");
        empty.className = "rig-bone-empty";
        empty.textContent = "No bones";
        this.rigBoneList.replaceChildren(empty);
        return;
      }
      const activeBone = this.activeBoneName;
      const activeChain = new Set(this.selectedBoneChainNames?.() || []);
      this.rigBoneList.replaceChildren(...names.map((name) => {
        const button = document.createElement("button");
        button.type = "button";
        const inSelectedChain = activeChain.has(name);
        button.className = `rig-bone-item${name === activeBone ? " is-active" : ""}${inSelectedChain ? " is-chain-selected" : ""}`;
        button.title = name;
        button.dataset.rigBoneName = name;
        button.addEventListener("click", () => this.setActiveBone(name));

        const label = document.createElement("span");
        label.className = "rig-bone-name";
        label.textContent = this.boneDisplayName(name);

        const meta = document.createElement("span");
        meta.className = "rig-bone-meta";
        meta.textContent = inSelectedChain ? "Chain" : this.rigBoneGroupForName(name).label;

        button.replaceChildren(label, meta);
        return button;
      }));
    },

    normalizedBoneLabel(name) {
      return this.boneDisplayName(name).replace(/\s+/g, "").toLowerCase();
    },

    findDefaultBone(names) {
      const preferred = [
        this.actorTarget?.defaultBone,
        "LeftArm",
        "Head",
        "Hips",
        names[0]
      ].filter(Boolean);
      for (const preferredName of preferred) {
        const match = names.find((name) => name === preferredName || this.normalizedBoneLabel(name) === this.normalizedBoneLabel(preferredName));
        if (match) {
          return match;
        }
      }
      return names[0] || "";
    },

    collapsedMirrorBoneNames(names) {
      const result = [];
      const seenLabels = new Set();
      for (const name of names) {
        if (!this.isMirrorableBone(name)) {
          result.push(name);
          continue;
        }
        const canonicalName = this.canonicalMirrorBone(name);
        const label = this.boneDisplayName(canonicalName);
        if (seenLabels.has(label)) {
          continue;
        }
        seenLabels.add(label);
        result.push(canonicalName);
      }
      return result;
    },

    isMirrorableBone(name) {
      const mirrorName = this.mirrorBoneName(name);
      return Boolean(mirrorName && this.bones.has(mirrorName));
    },

    mirrorPose(pose) {
      return {
        x: pose.x || 0,
        y: -(pose.y || 0),
        z: -(pose.z || 0),
        px: -(pose.px || 0),
        py: pose.py || 0,
        pz: pose.pz || 0
      };
    },

    mirroredBoneEntries(boneName, pose) {
      if (!this.mirrorMode || !this.isMirrorableBone(boneName)) {
        return [[boneName, pose]];
      }
      return [
        [boneName, pose],
        [this.mirrorBoneName(boneName), this.mirrorPose(pose)]
      ];
    },

    effectivePoseSource(source) {
      if (!this.mirrorMode) {
        return source;
      }
      const result = { ...source };
      for (const [boneName, pose] of Object.entries(source)) {
        const mirrorName = this.mirrorBoneName(boneName);
        if (!mirrorName || !this.bones.has(mirrorName) || result[mirrorName]) {
          continue;
        }
        result[mirrorName] = this.mirrorPose(pose);
      }
      return result;
    }
  });
}
