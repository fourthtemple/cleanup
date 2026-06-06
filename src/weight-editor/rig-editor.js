export function installRigEditorMethods(BirdWeightEditor, deps) {
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
    renderAddBoneParentOptions(selectedName = "") {
      if (!this.addBoneParentSelect) {
        return;
      }
      const current = selectedName || this.addBoneParentSelect.value || this.activeBoneName || this.findDefaultBone([...this.bones.keys()]);
      const options = [...this.bones.keys()]
        .sort((a, b) => this.boneDisplayName(a).localeCompare(this.boneDisplayName(b)))
        .map((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = this.boneDisplayName(name);
          return option;
        });
      this.addBoneParentSelect.replaceChildren(...options);
      this.addBoneParentSelect.value = this.bones.has(current) ? current : this.findDefaultBone([...this.bones.keys()]);
    },

    boneEditorNumber(input, fallback = 0) {
      const value = Number(input?.value);
      return Number.isFinite(value) ? value : fallback;
    },

    cleanTransformValues(values) {
      return values.map((value) => Number((Number(value) || 0).toFixed(5)));
    },

    boneEditorTransformFromControls() {
      return {
        position: this.cleanTransformValues([
          this.boneEditorNumber(this.addBonePosX, 0),
          this.boneEditorNumber(this.addBonePosY, -0.12),
          this.boneEditorNumber(this.addBonePosZ, 0)
        ]),
        rotation: this.cleanTransformValues([
          this.boneEditorNumber(this.addBoneRotX, 0),
          this.boneEditorNumber(this.addBoneRotY, 0),
          this.boneEditorNumber(this.addBoneRotZ, 0)
        ])
      };
    },

    setBoneEditorTransform(position = [0, -0.12, 0], rotation = [0, 0, 0]) {
      const [px, py, pz] = this.cleanTransformValues(position);
      const [rx, ry, rz] = this.cleanTransformValues(rotation);
      if (this.addBonePosX) this.addBonePosX.value = String(px);
      if (this.addBonePosY) this.addBonePosY.value = String(py);
      if (this.addBonePosZ) this.addBonePosZ.value = String(pz);
      if (this.addBoneRotX) this.addBoneRotX.value = String(rx);
      if (this.addBoneRotY) this.addBoneRotY.value = String(ry);
      if (this.addBoneRotZ) this.addBoneRotZ.value = String(rz);
    },

    captureRigEditorUndoState() {
      const transform = this.boneEditorTransformFromControls();
      return {
        pendingBonePlacement: Boolean(this.pendingBonePlacement),
        addBoneName: this.addBoneNameInput?.value || "",
        editingBone: this.addBoneNameInput?.dataset?.editingBone || "",
        addBoneParent: this.addBoneParentSelect?.value || "",
        selectedChainMembers: Array.from(this.addBoneChainMembersSelect?.selectedOptions || [])
          .map((option) => option.value)
          .filter((name) => this.bones?.has?.(name)),
        position: transform.position,
        rotation: transform.rotation
      };
    },

    restoreRigEditorUndoState(state = {}) {
      if (!state || typeof state !== "object") {
        this.setBonePlacementPending(false);
        return;
      }
      if (this.addBoneNameInput) {
        this.addBoneNameInput.value = state.addBoneName || "NewBone";
        if (state.editingBone) {
          this.addBoneNameInput.dataset.editingBone = state.editingBone;
        } else {
          delete this.addBoneNameInput.dataset.editingBone;
        }
      }
      this.renderAddBoneParentOptions(state.addBoneParent);
      if (this.addBoneParentSelect && state.addBoneParent && [...this.addBoneParentSelect.options].some((option) => option.value === state.addBoneParent)) {
        this.addBoneParentSelect.value = state.addBoneParent;
      }
      if (this.addBoneChainMembersSelect && Array.isArray(state.selectedChainMembers)) {
        const selected = new Set(state.selectedChainMembers.filter((name) => this.bones?.has?.(name)));
        for (const option of Array.from(this.addBoneChainMembersSelect.options || [])) {
          option.selected = selected.has(option.value);
        }
        this.syncSelectedBoneChainFromMemberSelect?.();
      }
      this.setBoneEditorTransform(state.position || [0, -0.12, 0], state.rotation || [0, 0, 0]);
      this.setBonePlacementPending(Boolean(state.pendingBonePlacement));
    },

    captureRigHistorySnapshot() {
      if (!this.model || !this.bones?.size) {
        return null;
      }
      return {
        virtualBones: (this.virtualBones || []).map((bone) => ({
          name: bone.name,
          parent: bone.parent,
          position: [...(bone.position || [])],
          rotation: [...(bone.rotation || [])],
          ...(bone.role ? { role: bone.role } : {})
        })),
        manualBoneChains: (this.manualBoneChains || []).map((chain) => ({
          id: chain.id,
          name: chain.name,
          bones: [...(chain.bones || [])],
          ik: chain.ik ? { ...chain.ik } : null
        })),
        ikChainSettings: [...(this.ikChainSettings?.entries?.() || [])].map(([key, settings]) => [key, { ...settings }]),
        jointConstraints: this.serializeJointConstraints?.() || [],
        activeBoneName: this.activeBoneName || "",
        selectedBoneChainRootName: this.selectedBoneChainRootName || "",
        rigEditor: this.captureRigEditorUndoState?.() || null
      };
    },

    rigHistorySnapshotsMatch(before, after) {
      return JSON.stringify(before || null) === JSON.stringify(after || null);
    },

    restoreRigHistorySnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return false;
      }
      this.boneMoveGizmoArmed = false;
      this.ikTargetGizmoArmed = false;
      const currentNames = new Set((this.virtualBones || []).map((bone) => bone.name));
      const currentRecords = new Map((this.virtualBones || []).map((bone) => [bone.name, bone]));
      for (const name of currentNames) {
        const bone = this.bones.get(name);
        if (currentRecords.get(name)?.role === "rootMotion" && bone?.parent) {
          bone.position.set(0, 0, 0);
          bone.quaternion.identity();
          bone.scale.set(1, 1, 1);
          const parent = bone.parent;
          for (const child of [...bone.children]) {
            parent.add(child);
          }
        }
        bone?.parent?.remove(bone);
        this.bones.delete(name);
        this.manualPose?.delete?.(name);
      }
      this.bindPose = (this.bindPose || []).filter((entry) => !currentNames.has(entry.object?.name));
      this.virtualBones = [];
      this.manualBoneChains = [];
      this.ikChainSettings?.clear?.();

      for (const bone of snapshot.virtualBones || []) {
        if (bone.role === "rootMotion") {
          this.ensureRootMotionUnbakeBone?.(this.rootMotionUnbakeHipBone?.(), { name: bone.name });
          continue;
        }
        this.addVirtualBone({
          name: bone.name,
          parent: bone.parent,
          position: bone.position,
          rotation: bone.rotation
        }, { sync: false, select: false });
      }
      this.applySerializedJointConstraints?.(snapshot.jointConstraints || []);
      this.applyBoneChains?.(snapshot.manualBoneChains || []);
      for (const [key, settings] of snapshot.ikChainSettings || []) {
        this.ikChainSettings?.set?.(key, this.normalizeIkChainSettings?.(settings) || { ...settings });
      }
      this.selectedBoneChainRootName = snapshot.selectedBoneChainRootName || "";
      const activeName = this.bones.has(snapshot.activeBoneName)
        ? snapshot.activeBoneName
        : this.findDefaultBone([...this.bones.keys()]);
      this.rebuildSkinnedSkeletons();
      this.applyPose(this.progress);
      this.refreshRigControls(activeName);
      this.restoreRigEditorUndoState?.(snapshot.rigEditor);
      this.refreshRigOverlays();
      this.syncPatchJson();
      this.updateSelectionInfluences?.();
      return true;
    },

    customBoneRecord(name = this.activeBoneName) {
      return this.virtualBones.find((bone) => bone.name === name) || null;
    },

    syncBoneEditorControls(name = this.activeBoneName) {
      const record = this.customBoneRecord(name);
      if (record) {
        if (this.addBoneNameInput) {
          this.addBoneNameInput.value = record.name;
          this.addBoneNameInput.dataset.editingBone = record.name;
        }
        this.renderAddBoneParentOptions(record.parent);
        this.setBoneEditorTransform(record.position, record.rotation);
        return;
      }

      const previousEditingBone = this.addBoneNameInput?.dataset.editingBone || "";
      if (this.addBoneNameInput) {
        delete this.addBoneNameInput.dataset.editingBone;
        if (!this.addBoneNameInput.value || this.addBoneNameInput.value === previousEditingBone) {
          this.addBoneNameInput.value = previousEditingBone ? this.nextSuggestedBoneName(previousEditingBone) : "NewBone";
        }
      }
      const parentName = this.bones.has(name) ? name : this.findDefaultBone([...this.bones.keys()]);
      this.renderAddBoneParentOptions(parentName);
      this.setBoneEditorTransform([0, -0.12, 0], [0, 0, 0]);
    },

    sanitizeNewBoneName(name) {
      return String(name || "")
        .trim()
        .replace(/\s+/g, "")
        .replace(/[^A-Za-z0-9_:-]/g, "");
    },

    uniqueBoneName(baseName) {
      const clean = this.sanitizeNewBoneName(baseName) || "NewBone";
      if (!this.bones.has(clean)) {
        return clean;
      }
      for (let index = 2; index < 1000; index += 1) {
        const candidate = `${clean}${index}`;
        if (!this.bones.has(candidate)) {
          return candidate;
        }
      }
      return `${clean}${Date.now()}`;
    },

    addBoneFromControls() {
      this.boneMoveGizmoArmed = false;
      this.setBonePlacementPending(false);
      const name = this.uniqueBoneName(this.addBoneNameInput?.value || "NewBone");
      const parentName = this.addBoneParentSelect?.value || this.activeBoneName || this.findDefaultBone([...this.bones.keys()]);
      const transform = this.boneEditorTransformFromControls();
      const added = this.addVirtualBone({
        name,
        parent: parentName,
        position: transform.position,
        rotation: transform.rotation
      });
      if (!added) {
        this.setStatus("Could not add bone");
        return;
      }
      this.setStatus(`Added ${name}`);
    },

    addBoneChainFromControls() {
      if (!this.model || !this.bones.size) {
        this.setStatus("Load a rigged model first");
        return [];
      }

      this.boneMoveGizmoArmed = false;
      this.setBonePlacementPending(false);
      const selectedNames = this.orderedBoneChainSelection(
        Array.from(this.addBoneChainMembersSelect?.selectedOptions || [])
          .map((option) => option.value)
          .filter((name) => this.bones.has(name))
      );

      if (selectedNames.length < 2) {
        this.setStatus("Select at least two bones for the chain");
        return [];
      }

      const chain = this.upsertManualBoneChain(selectedNames);
      this.selectedBoneChainRootName = chain.id;
      this.syncPatchJson();
      this.refreshRigControls(selectedNames[0], { selectedBoneChainRootName: chain.id });
      this.refreshRigOverlays();
      this.setStatus(`Added ${selectedNames.length}-bone chain ${this.boneDisplayName(selectedNames[0])} -> ${this.boneDisplayName(selectedNames[selectedNames.length - 1])}`);
      return selectedNames;
    },

    selectedBoneChainMemberNamesFromControl() {
      return this.orderedBoneChainSelection?.(
        Array.from(this.addBoneChainMembersSelect?.selectedOptions || [])
          .map((option) => option.value)
          .filter((name) => this.bones.has(name))
      ) || [];
    },

    updateRedistributeChainButtonState() {
      if (!this.redistributeChainWeightsButton) {
        return;
      }
      const hasSelectedChain = Boolean(this.selectedBoneChainRootName && this.selectedBoneChainNames?.(this.selectedBoneChainRootName)?.length >= 2);
      const hasSelectedMembers = this.selectedBoneChainMemberNamesFromControl().length >= 2;
      this.redistributeChainWeightsButton.disabled = !(hasSelectedChain || hasSelectedMembers);
    },

    orderedBoneChainSelection(names) {
      const uniqueNames = [...new Set(names)].filter((name) => this.bones.has(name));
      if (uniqueNames.length < 2) {
        return uniqueNames;
      }
      const selected = new Set(uniqueNames);
      const roots = uniqueNames.filter((name) => !selected.has(this.bones.get(name)?.parent?.name));
      if (roots.length !== 1) {
        return uniqueNames;
      }

      const ordered = [];
      let current = roots[0];
      while (current && selected.has(current) && !ordered.includes(current)) {
        ordered.push(current);
        const children = this.bones.get(current)?.children
          ?.filter((child) => child.isBone && selected.has(child.name))
          .map((child) => child.name) || [];
        current = children.length === 1 ? children[0] : "";
      }
      return ordered.length === uniqueNames.length ? ordered : uniqueNames;
    },

    manualBoneChainId(names) {
      return `manual:${names.join(">")}`;
    },

    manualBoneChainLabel(names) {
      const first = this.boneDisplayName(names[0]);
      const last = this.boneDisplayName(names[names.length - 1]);
      return first === last ? first : `${first} -> ${last}`;
    },

    upsertManualBoneChain(names) {
      const chainNames = this.orderedBoneChainSelection(names);
      const id = this.manualBoneChainId(chainNames);
      const existing = this.manualBoneChains.find((item) => item.id === id);
      const chain = {
        id,
        name: this.manualBoneChainLabel(chainNames),
        bones: chainNames,
        ik: existing?.ik ? { ...existing.ik } : this.defaultIkChainSettings?.()
      };
      this.manualBoneChains = [
        ...this.manualBoneChains.filter((item) => item.id !== id),
        chain
      ];
      this.setIkChainSettings?.(id, chain.ik, { silent: true, sync: false });
      return chain;
    },

    ensureBoneChainForDistribution() {
      const selectedRoot = this.boneChainSelect?.value || this.selectedBoneChainRootName || "";
      if (selectedRoot && this.selectedBoneChainNames?.(selectedRoot)?.length >= 2) {
        return selectedRoot;
      }
      const chainRoot = this.ensureSelectedBoneChain({ status: false });
      if (!chainRoot || this.selectedBoneChainNames?.(chainRoot)?.length < 2) {
        this.setStatus("Select at least two chain bones first");
        return "";
      }
      return chainRoot;
    },

    ensureSelectedBoneChain(options = {}) {
      const selectedNames = this.selectedBoneChainMemberNamesFromControl();
      if (selectedNames.length < 2) {
        return this.selectedBoneChainRootName || "";
      }
      const existingRoot = this.selectedBoneChainRootName || this.boneChainSelect?.value || "";
      const existingNames = existingRoot ? this.selectedBoneChainNames?.(existingRoot) || [] : [];
      const alreadyMatches = existingNames.length === selectedNames.length
        && existingNames.every((name, index) => name === selectedNames[index]);
      if (alreadyMatches) {
        return existingRoot;
      }
      const chain = this.upsertManualBoneChain(selectedNames);
      this.selectedBoneChainRootName = chain.id;
      this.chainBoneSelectionMode = "chain";
      this.ikEndBoneName = "";
      if (this.boneChainSelect) {
        this.boneChainSelect.value = chain.id;
      }
      this.syncPatchJson();
      this.renderBoneChainOptions?.(chain.id);
      this.renderAddBoneChainMemberOptions?.(selectedNames);
      this.updateRigBoneList?.();
      this.updateIkSettingsControls?.();
      this.updateRedistributeChainButtonState?.();
      if (options.status !== false) {
        this.setStatus(`Added ${selectedNames.length}-bone chain ${this.boneDisplayName(selectedNames[0])} -> ${this.boneDisplayName(selectedNames[selectedNames.length - 1])}`);
      }
      return chain.id;
    },

    tutorialDemoFkIkChainNames(side = "left") {
      const prefix = String(side || "left").toLowerCase() === "right" ? "Right" : "Left";
      return [
        `mixamorig${prefix}Shoulder`,
        `mixamorig${prefix}Arm`,
        `mixamorig${prefix}ForeArm`,
        `mixamorig${prefix}Hand`
      ].filter((name) => this.bones.has(name));
    },

    ensureTutorialDemoFkIkChain(options = {}) {
      const names = this.tutorialDemoFkIkChainNames(options.side || "left");
      if (names.length < 4) {
        if (options.status !== false) {
          this.setStatus("Could not find the shoulder, arm, forearm, and hand bones for the FK/IK demo");
        }
        return "";
      }
      const chain = this.upsertManualBoneChain(names);
      this.selectedBoneChainRootName = chain.id;
      this.chainBoneSelectionMode = "chain";
      this.ikEndBoneName = names[names.length - 1];
      this.renderBoneChainOptions?.(chain.id);
      this.renderAddBoneChainMemberOptions?.(names);
      this.setActiveBone(this.ikEndBoneName, {
        selectedBoneChainRootName: chain.id,
        preserveBoneChainMemberSelection: true
      });
      this.selectedBoneChainRootName = chain.id;
      if (this.boneChainSelect) {
        this.boneChainSelect.value = chain.id;
      }
      this.updateIkSettingsControls?.();
      this.updateRedistributeChainButtonState?.();
      if (options.status !== false) {
        this.setStatus(`Prepared FK/IK chain ${this.boneDisplayName(names[0])} -> ${this.boneDisplayName(names[names.length - 1])}`);
      }
      return chain.id;
    },

    applyBoneChains(chains) {
      this.manualBoneChains = [];
      if (!Array.isArray(chains)) {
        return;
      }
      for (const chain of chains) {
        const names = this.orderedBoneChainSelection(
          (Array.isArray(chain?.bones) ? chain.bones : [])
            .map((name) => String(name || ""))
            .filter((name) => this.bones.has(name))
        );
        if (names.length >= 2) {
          const record = this.upsertManualBoneChain(names);
          record.name = String(chain.name || record.name);
          const ik = chain.ik || chain.ikSettings;
          if (ik) {
            record.ik = this.normalizeIkChainSettings?.(ik);
            this.setIkChainSettings?.(record.id, record.ik, { silent: true, sync: false });
          }
        }
      }
      this.updateIkSettingsControls?.();
    },

    renderAddBoneChainMemberOptions(selectedNames = (
      this.selectedBoneChainRootName
        ? this.selectedBoneChainNames?.(this.selectedBoneChainRootName) || []
        : this.chainBoneSelectionMode === "none" ? [] : this.activeBoneName ? [this.activeBoneName] : []
    )) {
      if (!this.addBoneChainMembersSelect) {
        return;
      }
      const selected = new Set(selectedNames);
      const names = this.boneLayerNames.length ? this.boneLayerNames : [...this.bones.keys()];
      this.addBoneChainMembersSelect.replaceChildren(...names.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = this.boneDisplayName(name);
        option.selected = selected.has(name);
        return option;
      }));
      this.updateRedistributeChainButtonState?.();
    },

    customBoneChildNames(parentName) {
      return this.virtualBones
        .filter((bone) => bone.parent === parentName)
        .map((bone) => bone.name);
    },

    customBoneRootName(name) {
      let record = this.customBoneRecord(name);
      if (!record) {
        return "";
      }
      let rootName = record.name;
      while (record && this.customBoneRecord(record.parent)) {
        rootName = record.parent;
        record = this.customBoneRecord(record.parent);
      }
      return rootName;
    },

    customBoneChainNames(rootName) {
      const root = this.customBoneRootName(rootName) || rootName;
      if (!this.customBoneRecord(root)) {
        return [];
      }
      const names = [];
      const visit = (name) => {
        if (!this.customBoneRecord(name) || names.includes(name)) {
          return;
        }
        names.push(name);
        for (const childName of this.customBoneChildNames(name)) {
          visit(childName);
        }
      };
      visit(root);
      return names;
    },

    customBoneChains() {
      const manualChains = this.manualBoneChains
        .map((chain) => ({
          root: chain.id,
          names: chain.bones.filter((name) => this.bones.has(name)),
          label: chain.name || this.manualBoneChainLabel(chain.bones)
        }))
        .filter((chain) => chain.names.length > 0);
      const virtualChains = this.virtualBones
        .filter((bone) => !this.customBoneRecord(bone.parent))
        .map((bone) => ({
          root: bone.name,
          names: this.customBoneChainNames(bone.name),
          label: this.boneDisplayName(bone.name)
        }))
        .filter((chain) => chain.names.length > 0);
      return [...manualChains, ...virtualChains];
    },

    selectedBoneChainNames(rootName = this.selectedBoneChainRootName) {
      const manual = this.manualBoneChains.find((chain) => chain.id === rootName);
      if (manual) {
        return manual.bones.filter((name) => this.bones.has(name));
      }
      const root = this.customBoneRootName(rootName) || rootName || this.customBoneRootName(this.activeBoneName);
      if (!root) {
        return [];
      }
      const chain = this.customBoneChains().find((item) => item.root === root);
      return chain ? chain.names : this.customBoneChainNames(root);
    },

    renderBoneChainOptions(selectedName = this.selectedBoneChainRootName) {
      if (!this.boneChainSelect) {
        return;
      }
      const chains = this.customBoneChains();
      if (!chains.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No custom chains";
        this.boneChainSelect.replaceChildren(option);
        this.boneChainSelect.value = "";
        this.boneChainSelect.disabled = true;
        this.selectedBoneChainRootName = "";
        if (this.redistributeChainWeightsButton) {
          this.redistributeChainWeightsButton.disabled = true;
        }
        this.updateIkSettingsControls?.();
        return;
      }

      const explicitClear = selectedName === "";
      const requestedRoot = explicitClear ? "" : this.customBoneRootName(selectedName) || selectedName || this.customBoneRootName(this.activeBoneName);
      const current = chains.some((chain) => chain.root === requestedRoot) ? requestedRoot : "";
      this.selectedBoneChainRootName = current;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Bone chain";
      this.boneChainSelect.replaceChildren(placeholder, ...chains.map((chain) => {
        const option = document.createElement("option");
        option.value = chain.root;
        option.textContent = `${chain.label || this.boneDisplayName(chain.root)} (${chain.names.length} ${chain.names.length === 1 ? "bone" : "bones"})`;
        return option;
      }));
      this.boneChainSelect.disabled = false;
      this.boneChainSelect.value = current;
      if (this.redistributeChainWeightsButton) {
        this.updateRedistributeChainButtonState();
      }
      this.updateIkSettingsControls?.();
    },

    selectBoneChain(rootName) {
      const chain = this.customBoneChains().find((item) => item.root === rootName);
      const root = chain?.root || this.customBoneRootName(rootName) || rootName;
      const names = chain?.names || this.customBoneChainNames(root);
      if (!names.length) {
        this.setStatus("Choose a custom bone chain first");
        return [];
      }
      this.selectedBoneChainRootName = root;
      this.chainBoneSelectionMode = "chain";
      this.ikEndBoneName = "";
      if (this.boneChainSelect) {
        this.boneChainSelect.value = root;
      }
      this.setActiveBone(names[0], { selectedBoneChainRootName: root });
      this.selectedBoneChainRootName = root;
      if (this.boneChainSelect) {
        this.boneChainSelect.value = root;
      }
      this.renderAddBoneChainMemberOptions(names);
      this.updateRigBoneList();
      this.updateIkSettingsControls?.();
      this.setStatus(`Selected ${this.boneDisplayName(names[0])} chain (${names.length} ${names.length === 1 ? "bone" : "bones"})`);
      return names;
    },

    clearSelectedBoneChainState() {
      this.selectedBoneChainRootName = "";
      this.chainBoneSelectionMode = "none";
      this.ikEndBoneName = "";
      if (this.boneChainSelect) {
        this.boneChainSelect.value = "";
      }
      this.updateIkSettingsControls?.();
      this.updateRedistributeChainButtonState?.();
    },

    selectSingleBoneChainMember(name = this.activeBoneName) {
      const boneName = this.canonicalMirrorBone(name);
      if (!this.addBoneChainMembersSelect || !this.bones.has(boneName)) {
        return false;
      }
      this.clearSelectedBoneChainState();
      this.chainBoneSelectionMode = "single";
      let matched = false;
      for (const option of Array.from(this.addBoneChainMembersSelect.options || [])) {
        option.selected = option.value === boneName;
        matched = matched || option.selected;
      }
      this.updateRedistributeChainButtonState?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBonePickerOverlay?.();
      this.updateRigBoneList?.();
      return matched;
    },

    syncSelectedBoneChainFromMemberSelect() {
      const names = this.orderedBoneChainSelection?.(
        Array.from(this.addBoneChainMembersSelect?.selectedOptions || [])
          .map((option) => option.value)
          .filter((name) => this.bones.has(name))
      ) || [];
      if (names.length === 1) {
        this.clearSelectedBoneChainState();
        this.chainBoneSelectionMode = "single";
        this.setActiveBone(names[0], {
          suppressBoneChainAutoSelect: true,
          preserveBoneChainMemberSelection: true
        });
      } else if (names.length < 2) {
        this.clearSelectedBoneChainState();
      } else {
        const existing = this.customBoneChains().find((chain) => (
          chain.names.length === names.length
          && chain.names.every((name, index) => name === names[index])
        ));
        this.selectedBoneChainRootName = existing?.root || "";
        this.chainBoneSelectionMode = "chain";
        this.ikEndBoneName = "";
        if (this.boneChainSelect) {
          this.boneChainSelect.value = existing?.root || "";
        }
        this.updateIkSettingsControls?.();
      }
      this.updateRedistributeChainButtonState?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBonePickerOverlay?.();
      this.updateRigBoneList?.();
      return names;
    },

    setBonePlacementPending(active) {
      this.pendingBonePlacement = Boolean(active);
      if (this.pendingBonePlacement) {
        this.boneMoveGizmoArmed = false;
        this.ikTargetGizmoArmed = false;
      }
      if (this.placeBoneSelectionButton) {
        this.placeBoneSelectionButton.classList.toggle("is-active", this.pendingBonePlacement);
        this.placeBoneSelectionButton.setAttribute("aria-pressed", String(this.pendingBonePlacement));
      }
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
    },

    beginBonePlacement() {
      if (!this.model || !this.bones.size) {
        this.setStatus("Load a rigged model first");
        return false;
      }
      this.setBonePlacementPending(true);
      this.pausePlayback();
      this.setSidePanelOpen(true);
      this.setRigPanelOpen(true);
      this.setTool("bone", { preserveViewportLayers: true });
      this.setViewMode("mesh", { silent: true });
      this.showBonesLayer = true;
      this.syncViewportLayerButtons?.();
      this.updateSkeletonHelper();
      this.updateBonePickerOverlay();
      this.setStatus("Create ready: click a joint to start, then click the model to extend the chain");
      return true;
    },

    finishBonePlacement(parentName, { worldPoint = null, keepPlacing = true } = {}) {
      if (!this.pendingBonePlacement) {
        return false;
      }
      const parent = this.bones.get(parentName);
      if (!parent) {
        this.setStatus("Click a visible bone joint");
        return false;
      }
      if (this.addBoneParentSelect) {
        this.addBoneParentSelect.value = parent.name;
      }
      const name = this.uniqueBoneName(this.addBoneNameInput?.value || "NewBone");
      const transform = this.boneEditorTransformFromControls();
      if (worldPoint) {
        parent.updateMatrixWorld(true);
        const local = parent.worldToLocal(worldPoint.clone());
        transform.position = this.cleanTransformValues(local.toArray());
        this.setBoneEditorTransform(transform.position, transform.rotation);
      }
      const undoBefore = this.captureRigHistorySnapshot?.();
      const added = this.addVirtualBone({
        name,
        parent: parent.name,
        position: transform.position,
        rotation: transform.rotation
      });
      if (!added) {
        this.setStatus("Could not add bone");
        return false;
      }
      this.pushRigUndoState?.("Create bone", {
        before: undoBefore,
        after: this.captureRigHistorySnapshot?.()
      });
      if (keepPlacing) {
        this.renderAddBoneParentOptions(name);
        if (this.addBoneParentSelect) {
          this.addBoneParentSelect.value = name;
        }
        if (this.addBoneNameInput) {
          delete this.addBoneNameInput.dataset.editingBone;
          this.addBoneNameInput.value = this.nextAvailableBoneName(name);
        }
        this.setBoneEditorTransform([0, -0.12, 0], transform.rotation);
        this.setBonePlacementPending(true);
        this.updateBonePickerOverlay();
        this.setStatus(`Added ${name} to ${this.boneDisplayName(parent.name)}. Click the next point to extend from ${this.boneDisplayName(name)}`);
        return true;
      }
      this.setBonePlacementPending(false);
      this.setStatus(`Added ${name} to ${this.boneDisplayName(parent.name)}`);
      return true;
    },

    nextSuggestedBoneName(name) {
      const match = String(name).match(/^(.*?)(\d+)$/);
      if (!match) {
        return `${name}2`;
      }
      return `${match[1]}${Number(match[2]) + 1}`;
    },

    nextAvailableBoneName(name) {
      const clean = this.sanitizeNewBoneName(name) || "NewBone";
      const match = clean.match(/^(.*?)(\d+)$/);
      const prefix = match ? match[1] : clean;
      const start = match ? Number(match[2]) + 1 : 2;
      for (let index = start; index < 1000; index += 1) {
        const candidate = `${prefix}${index}`;
        if (!this.bones.has(candidate)) {
          return candidate;
        }
      }
      return this.uniqueBoneName(clean);
    },

    isDescendantBone(name, ancestorName) {
      let bone = this.bones.get(name);
      while (bone?.parent) {
        if (bone.parent.name === ancestorName) {
          return true;
        }
        bone = bone.parent;
      }
      return false;
    },

    renamePoseReferences(fromName, toName) {
      const manualPose = this.manualPose.get(fromName);
      if (manualPose) {
        this.manualPose.delete(fromName);
        this.manualPose.set(toName, manualPose);
      }
      for (const framePose of this.poseKeyframes.values()) {
        if (framePose[fromName]) {
          framePose[toName] = framePose[fromName];
          delete framePose[fromName];
        }
      }
    },

    toggleActiveBoneMoveGizmo() {
      const activeBone = this.bones.get(this.activeBoneName);
      if (
        this.boneMoveGizmoArmed
        && this.transformControls?.object === activeBone
        && this.transformHelper?.visible
      ) {
        this.boneMoveGizmoArmed = false;
        this.updateBoneMoveGizmo();
        this.updateGizmoOnlyPreviewButton?.();
        this.setStatus("Bone gizmo off");
        return false;
      }
      if (!activeBone) {
        this.setStatus("Select a bone to move");
        return false;
      }
      this.ikTargetGizmoArmed = false;
      if (this.customBoneRecord(this.activeBoneName) && !this.updateActiveVirtualBoneFromControls()) {
        return false;
      }
      this.ensureSelectedBoneChain?.({ status: false });
      return this.showActiveBoneMoveGizmo();
    },

    fkGizmoTransformMode() {
      return this.fkGizmoMode === "translate" ? "translate" : "rotate";
    },

    setFkGizmoMode(mode = "rotate", options = {}) {
      const nextMode = mode === "translate" ? "translate" : "rotate";
      this.fkGizmoMode = nextMode;
      for (const input of this.fkGizmoModeInputs || []) {
        input.checked = input.value === nextMode;
      }
      if (this.boneMoveGizmoArmed) {
        this.updateBoneMoveGizmo();
      }
      this.syncPoseGizmoModeControls?.();
      if (!options.silent) {
        this.setStatus(`FK ${nextMode === "rotate" ? "rotate" : "move"}`);
      }
      return nextMode;
    },

    syncPoseGizmoModeControls() {
      const activeMode = this.activePoseGizmoMode?.() || "";
      if (this.fkGizmoModeControl) {
        this.fkGizmoModeControl.hidden = activeMode !== "fk";
      }
      if (this.timelineIkSettings) {
        this.timelineIkSettings.hidden = activeMode === "fk";
      }
    },

    showActiveBoneMoveGizmo() {
      const bone = this.bones.get(this.activeBoneName);
      if (!bone) {
        this.setStatus("Select a bone to move");
        return false;
      }
      this.preparePoseGizmoModeSwitch?.("fk");
      this.ikTargetGizmoArmed = false;
      this.setBonePlacementPending(false);
      this.pausePlayback();
      this.setSidePanelOpen(true);
      this.setRigPanelOpen(true);
      this.setTool("bone", { preserveViewportLayers: true });
      this.boneMoveGizmoArmed = true;
      this.refreshRigOverlays();
      this.syncPoseGizmoModeControls?.();
      const modeLabel = this.fkGizmoTransformMode() === "rotate" ? "Rotate" : "Move";
      this.setStatus(`${modeLabel} ${this.boneDisplayName(this.activeBoneName)} with the FK gizmo`);
      return true;
    },

    updateActiveVirtualBoneFromControls(options = {}) {
      this.setBonePlacementPending(false);
      const originalName = this.activeBoneName;
      const record = this.customBoneRecord(originalName);
      const bone = this.bones.get(originalName);
      if (!record || !bone) {
        this.setStatus("Select a custom bone to update");
        return false;
      }

      const nextName = this.sanitizeNewBoneName(this.addBoneNameInput?.value || originalName) || originalName;
      if (nextName !== originalName && this.bones.has(nextName)) {
        this.setStatus(`${nextName} already exists`);
        return false;
      }
      const parentName = this.addBoneParentSelect?.value || record.parent;
      const parent = this.bones.get(parentName);
      if (!parent) {
        this.setStatus("Choose a parent bone first");
        return false;
      }
      if (parentName === originalName || this.isDescendantBone(parentName, originalName)) {
        this.setStatus("A bone cannot be parented to itself or its child");
        return false;
      }

      const transform = this.boneEditorTransformFromControls();
      if (bone.parent !== parent) {
        parent.add(bone);
      }
      bone.position.set(...transform.position);
      bone.rotation.set(...transform.rotation);
      bone.updateMatrixWorld(true);

      if (nextName !== originalName) {
        this.bones.delete(originalName);
        bone.name = nextName;
        this.bones.set(nextName, bone);
        for (const virtualBone of this.virtualBones) {
          if (virtualBone.parent === originalName) {
            virtualBone.parent = nextName;
          }
        }
        this.renamePoseReferences(originalName, nextName);
        if (this.selectedBoneChainRootName === originalName) {
          this.selectedBoneChainRootName = nextName;
        }
      }

      record.name = nextName;
      record.parent = parent.name;
      record.position = transform.position;
      record.rotation = transform.rotation;
      const rest = this.bindPose.find((entry) => entry.object === bone);
      if (rest) {
        rest.position.copy(bone.position);
        rest.quaternion.copy(bone.quaternion);
        rest.scale.copy(bone.scale);
      } else {
        this.bindPose.push({
          object: bone,
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone(),
          scale: bone.scale.clone()
        });
      }

      this.activeBoneName = nextName;
      this.rebuildSkinnedSkeletons();
      this.applyPose(this.progress);
      this.refreshRigControls(nextName);
      this.refreshRigOverlays();
      this.syncPatchJson();
      if (options.status !== false) {
        this.setStatus(`Updated ${this.boneDisplayName(nextName)}`);
      }
      return true;
    },

    updateActiveVirtualBoneFromInspector(options = {}) {
      if (!this.customBoneRecord(this.activeBoneName)) {
        return false;
      }
      return this.updateActiveVirtualBoneFromControls(options);
    },

    placeBoneAtSelection() {
      const center = this.selectionWorldCenter();
      if (!center) {
        this.setStatus("Paint a vertex selection first");
        return false;
      }
      const activeRecord = this.customBoneRecord(this.activeBoneName);
      const parentName = activeRecord?.parent || this.addBoneParentSelect?.value || this.activeBoneName || this.findDefaultBone([...this.bones.keys()]);
      const parent = this.bones.get(parentName);
      if (!parent) {
        this.setStatus("Choose a parent bone first");
        return false;
      }
      parent.updateMatrixWorld(true);
      const local = parent.worldToLocal(center.clone());
      const currentTransform = this.boneEditorTransformFromControls();
      this.setBoneEditorTransform(local.toArray(), activeRecord?.rotation || currentTransform.rotation);

      if (activeRecord) {
        const placed = this.updateActiveVirtualBoneFromControls();
        if (placed) {
          this.setStatus(`Placed ${this.boneDisplayName(this.activeBoneName)} at selection`);
        }
        return placed;
      }

      this.addBoneFromControls();
      this.setStatus(`Added bone at selection`);
      return true;
    },

    addVirtualBone(definition, { sync = true, select = true } = {}) {
      const parent = this.bones.get(definition.parent) || this.bones.values().next().value;
      if (!parent || this.bones.has(definition.name)) {
        return false;
      }

      const bone = new THREE.Bone();
      bone.name = definition.name;
      const position = Array.isArray(definition.position) ? definition.position : [0, -0.12, 0];
      const rotation = Array.isArray(definition.rotation) ? definition.rotation : [0, 0, 0];
      bone.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
      bone.rotation.set(Number(rotation[0]) || 0, Number(rotation[1]) || 0, Number(rotation[2]) || 0);
      parent.add(bone);
      parent.updateMatrixWorld(true);
      bone.updateMatrixWorld(true);

      this.bones.set(bone.name, bone);
      this.virtualBones.push({
        name: bone.name,
        parent: parent.name,
        position: bone.position.toArray().map((value) => Number(value.toFixed(5))),
        rotation: [bone.rotation.x, bone.rotation.y, bone.rotation.z].map((value) => Number(value.toFixed(5)))
      });
      this.bindPose.push({
        object: bone,
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone()
      });
      this.rebuildSkinnedSkeletons();
      if (select) {
        this.selectedBoneChainRootName = this.customBoneRootName(bone.name) || bone.name;
      }
      this.refreshRigControls(select ? bone.name : this.activeBoneName);
      this.refreshRigOverlays();
      if (sync) {
        this.syncPatchJson();
      }
      return true;
    },

    resetVirtualBones() {
      if (!this.virtualBones.length) {
        return;
      }
      this.boneMoveGizmoArmed = false;
      const names = new Set(this.virtualBones.map((bone) => bone.name));
      const records = new Map(this.virtualBones.map((bone) => [bone.name, bone]));
      this.removeBoneInfluencesByNames(names);
      for (const name of names) {
        const bone = this.bones.get(name);
        if (records.get(name)?.role === "rootMotion" && bone?.parent) {
          bone.position.set(0, 0, 0);
          bone.quaternion.identity();
          bone.scale.set(1, 1, 1);
          const parent = bone.parent;
          for (const child of [...bone.children]) {
            parent.add(child);
          }
        }
        bone?.parent?.remove(bone);
        this.bones.delete(name);
        this.manualPose.delete(name);
      }
      for (const [frame, framePose] of this.poseKeyframes.entries()) {
        for (const name of names) {
          delete framePose[name];
        }
        if (!Object.keys(framePose).length) {
          this.poseKeyframes.delete(frame);
        }
      }
      this.bindPose = this.bindPose.filter((entry) => !names.has(entry.object?.name));
      this.virtualBones = [];
      this.manualBoneChains = [];
      this.ikChainSettings?.clear();
      this.selectedBoneChainRootName = "";
      this.rebuildSkinnedSkeletons();
      this.refreshRigControls(this.bones.has(this.activeBoneName) ? this.activeBoneName : this.findDefaultBone([...this.bones.keys()]));
      this.refreshRigOverlays();
    },

    virtualBoneDescendantNames(rootName) {
      const names = new Set([rootName]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const bone of this.virtualBones) {
          if (!names.has(bone.name) && names.has(bone.parent)) {
            names.add(bone.name);
            changed = true;
          }
        }
      }
      names.delete(rootName);
      return [...names];
    },

    deleteActiveVirtualBone() {
      const rootName = this.activeBoneName;
      const record = this.customBoneRecord(rootName);
      if (!record) {
        this.setStatus("Select a custom bone to delete");
        return false;
      }
      this.boneMoveGizmoArmed = false;
      const names = new Set([rootName, ...this.virtualBoneDescendantNames(rootName)]);
      const parentName = record.parent;
      this.removeBoneInfluencesByNames(names);
      for (const name of names) {
        const bone = this.bones.get(name);
        if (this.customBoneRecord(name)?.role === "rootMotion" && bone?.parent) {
          bone.position.set(0, 0, 0);
          bone.quaternion.identity();
          bone.scale.set(1, 1, 1);
          const parent = bone.parent;
          for (const child of [...bone.children]) {
            parent.add(child);
          }
        }
        bone?.parent?.remove(bone);
        this.bones.delete(name);
        this.manualPose.delete(name);
      }
      for (const [frame, framePose] of this.poseKeyframes.entries()) {
        for (const name of names) {
          delete framePose[name];
        }
        if (!Object.keys(framePose).length) {
          this.poseKeyframes.delete(frame);
        }
      }
      this.bindPose = this.bindPose.filter((entry) => !names.has(entry.object?.name));
      this.virtualBones = this.virtualBones.filter((bone) => !names.has(bone.name));
      this.manualBoneChains = this.manualBoneChains.filter((chain) => !chain.bones.some((name) => names.has(name)));
      for (const key of [...(this.ikChainSettings?.keys?.() || [])]) {
        if ([...names].some((name) => key.includes(name))) {
          this.ikChainSettings.delete(key);
        }
      }
      if (names.has(this.selectedBoneChainRootName)) {
        this.selectedBoneChainRootName = "";
      }
      this.rebuildSkinnedSkeletons();
      this.applyPose(this.progress);
      const fallback = this.bones.has(parentName) ? parentName : this.findDefaultBone([...this.bones.keys()]);
      this.refreshRigControls(fallback);
      this.refreshRigOverlays();
      this.syncPatchJson();
      this.updateSelectionInfluences();
      this.setStatus(`Deleted ${names.size} custom ${names.size === 1 ? "bone" : "bones"}`);
      return true;
    },

    removeBoneInfluencesByNames(namesToRemove) {
      const names = namesToRemove instanceof Set ? namesToRemove : new Set(namesToRemove);
      if (!names.size) {
        return;
      }
      for (const record of this.paintRecords) {
        const skeleton = record.object?.skeleton;
        if (!skeleton) {
          continue;
        }
        const skinIndex = record.geometry.attributes.skinIndex;
        const skinWeight = record.geometry.attributes.skinWeight;
        const vertexCount = record.geometry.attributes.position.count;
        let recordChanged = false;
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          const offset = vertexIndex * 4;
          const entries = [];
          let vertexChanged = false;
          for (let slot = 0; slot < 4; slot += 1) {
            const boneIndex = skinIndex.array[offset + slot];
            const weight = skinWeight.array[offset + slot];
            const bone = skeleton.bones[boneIndex];
            if (weight <= 0.0001) {
              continue;
            }
            if (bone && names.has(bone.name)) {
              vertexChanged = true;
              continue;
            }
            entries.push({ index: boneIndex, weight });
          }
          if (!vertexChanged) {
            continue;
          }
          this.setVertexWeightEntries(record, vertexIndex, entries);
          if (record.weightCompensated?.has(vertexIndex) && !record.sculpted?.has(vertexIndex)) {
            const positionOffset = vertexIndex * 3;
            record.geometry.attributes.position.array[positionOffset] = record.originalPosition[positionOffset];
            record.geometry.attributes.position.array[positionOffset + 1] = record.originalPosition[positionOffset + 1];
            record.geometry.attributes.position.array[positionOffset + 2] = record.originalPosition[positionOffset + 2];
            record.weightCompensated.delete(vertexIndex);
            record.geometry.attributes.position.needsUpdate = true;
          }
          if (this.isVertexEdited(record, vertexIndex)) {
            record.modified.add(vertexIndex);
          } else {
            record.modified.delete(vertexIndex);
          }
          recordChanged = true;
        }
        if (recordChanged) {
          record.geometry.attributes.position.needsUpdate = true;
          skinIndex.needsUpdate = true;
          skinWeight.needsUpdate = true;
          this.updateRecordColors(record);
        }
      }
    },

    captureSkeletonWeightNames(record) {
      const skeleton = record.object?.skeleton;
      if (!skeleton) {
        return [];
      }
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const vertexCount = record.geometry.attributes.position.count;
      return Array.from({ length: vertexCount }, (_, vertexIndex) => {
        const offset = vertexIndex * 4;
        const entries = [];
        for (let slot = 0; slot < 4; slot += 1) {
          const weight = skinWeight.array[offset + slot];
          if (weight <= 0.0001) {
            continue;
          }
          const bone = skeleton.bones[skinIndex.array[offset + slot]];
          if (bone?.name) {
            entries.push({ name: bone.name, weight });
          }
        }
        return entries;
      });
    },

    restoreSkeletonWeightNames(record, weightNames, nextBones) {
      if (!weightNames.length) {
        return;
      }
      const nameToIndex = new Map(nextBones.map((bone, index) => [bone.name, index]));
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      for (let vertexIndex = 0; vertexIndex < weightNames.length; vertexIndex += 1) {
        const merged = new Map();
        for (const entry of weightNames[vertexIndex]) {
          const index = nameToIndex.get(entry.name);
          if (index === undefined) {
            continue;
          }
          merged.set(index, (merged.get(index) || 0) + entry.weight);
        }
        const normalized = this.normalizeWeightEntries(
          [...merged.entries()].map(([index, weight]) => ({ index, weight }))
        ).slice(0, 4);
        const offset = vertexIndex * 4;
        for (let slot = 0; slot < 4; slot += 1) {
          skinIndex.array[offset + slot] = normalized[slot]?.index || 0;
          skinWeight.array[offset + slot] = normalized[slot]?.weight || 0;
        }
      }
      skinIndex.needsUpdate = true;
      skinWeight.needsUpdate = true;
    },

    rebuildSkinnedSkeletons() {
      const bones = [...this.bones.values()];
      const currentTransforms = this.bindPose.map(({ object }) => ({
        object,
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone()
      }));
      this.resetPose();
      this.model?.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        if (!record.object?.isSkinnedMesh || !record.object.skeleton) {
          continue;
        }
        const skeleton = record.object.skeleton;
        const weightNames = this.captureSkeletonWeightNames(record);
        const originalBones = skeleton.bones.slice();
        const originalInverses = skeleton.boneInverses.map((inverse) => inverse.clone());
        const originalNames = new Set(originalBones.map((bone) => bone.name));
        const nextBones = [
          ...originalBones.filter((bone) => this.bones.has(bone.name)),
          ...bones.filter((bone) => !originalNames.has(bone.name))
        ];
        const nextInverses = nextBones.map((bone) => {
          const originalIndex = originalBones.indexOf(bone);
          if (originalIndex >= 0 && originalInverses[originalIndex]) {
            return originalInverses[originalIndex].clone();
          }
          return new THREE.Matrix4().copy(bone.matrixWorld).invert();
        });

        skeleton.boneTexture?.dispose?.();
        skeleton.boneTexture = null;
        skeleton.bones = nextBones;
        skeleton.boneInverses = nextInverses;
        skeleton.init();
        this.restoreSkeletonWeightNames(record, weightNames, nextBones);
      }
      for (const { object, position, quaternion, scale } of currentTransforms) {
        object.position.copy(position);
        object.quaternion.copy(quaternion);
        object.scale.copy(scale);
      }
      this.model?.updateMatrixWorld(true);
    },

    updateBoneRecordFromObject(name = this.activeBoneName) {
      const record = this.customBoneRecord(name);
      const bone = this.bones.get(name);
      if (!record || !bone) {
        return false;
      }
      record.position = bone.position.toArray().map((value) => Number(value.toFixed(5)));
      record.rotation = [bone.rotation.x, bone.rotation.y, bone.rotation.z].map((value) => Number(value.toFixed(5)));
      const rest = this.bindPose.find((entry) => entry.object === bone);
      if (rest) {
        rest.position.copy(bone.position);
        rest.quaternion.copy(bone.quaternion);
        rest.scale.copy(bone.scale);
      }
      this.setBoneEditorTransform(record.position, record.rotation);
      return true;
    },

    updateBoneMoveGizmo() {
      if (!this.transformControls) {
        return;
      }
      const bone = this.bones.get(this.activeBoneName);
      const shouldShow = Boolean(
        (!this.cleanPreview || this.cleanPreviewAllowsRigGizmo?.())
        && this.activeTool === "bone"
        && !this.pendingBonePlacement
        && this.boneMoveGizmoArmed
        && bone
      );

      if (!shouldShow) {
        if (this.transformControls.object?.isBone) {
          this.transformControls.detach();
          this.transformControls.enabled = false;
          this.transformHelper.visible = false;
        }
        this.boneGizmoButton?.classList.remove("is-active");
        this.boneGizmoButton?.setAttribute("aria-pressed", "false");
        this.syncPoseGizmoModeControls?.();
        return;
      }

      const transformMode = this.fkGizmoTransformMode();
      this.transformControls.setMode(transformMode);
      this.transformControls.setSpace?.(transformMode === "rotate" ? "local" : "world");
      if (this.transformControls.object !== bone) {
        this.transformControls.attach(bone);
      }
      this.transformControls.enabled = true;
      this.transformHelper.visible = true;
      this.boneGizmoButton?.classList.add("is-active");
      this.boneGizmoButton?.setAttribute("aria-pressed", "true");
      this.updateGizmoOnlyPreviewButton?.();
      this.syncPoseGizmoModeControls?.();
    },

    beginBoneMove() {
      const bone = this.bones.get(this.activeBoneName);
      const record = this.customBoneRecord(this.activeBoneName);
      if (!bone) {
        this.boneMoveDrag = null;
        this.updateBoneMoveGizmo();
        return;
      }
      this.setBonePlacementPending(false);
      const gizmoMode = this.fkGizmoTransformMode();
      const manualPose = this.manualPose.get(bone.name) || {};
      const editedChannels = this.manualPoseEditedChannels?.get?.(bone.name)
        || new Set(Object.keys(manualPose).filter((channel) => ["x", "y", "z"].includes(channel)));
      const startManualPose = {};
      for (const channel of ["x", "y", "z", "px", "py", "pz"]) {
        if (editedChannels.has(channel) && manualPose[channel] !== undefined) {
          startManualPose[channel] = finitePoseValue(manualPose[channel]);
        }
      }
      this.beginPoseControlUndo(record
        ? gizmoMode === "rotate" ? "Rotate rig bone" : "Move rig bone"
        : gizmoMode === "rotate" ? "Rotate bone" : "Move bone");
      this.boneMoveDrag = {
        mode: record ? "rig" : "pose",
        gizmoMode,
        name: bone.name,
        bone,
        startPosition: bone.position.clone(),
        startQuaternion: bone.quaternion.clone(),
        startManualPose: record ? null : startManualPose,
        startEditedChannels: record ? null : new Set(editedChannels),
        startPose: record ? null : this.poseGizmoStartPose(bone.name)
      };
    },

    applyBoneMove() {
      if (!this.boneMoveDrag) {
        return;
      }
      if (this.boneMoveDrag.mode === "pose") {
        this.applyPoseBoneMove();
        return;
      }
      const { bone } = this.boneMoveDrag;
      bone.updateMatrixWorld(true);
      this.model?.updateMatrixWorld(true);
      this.updateBoneRecordFromObject(bone.name);
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLabels();
    },

    finishBoneMove() {
      if (!this.boneMoveDrag) {
        this.updateBoneMoveGizmo();
        return;
      }
      const { bone, name } = this.boneMoveDrag;
      if (this.boneMoveDrag.mode === "pose") {
        const actionLabel = this.boneMoveDrag.gizmoMode === "rotate" ? "Rotated" : "Moved";
        this.applyPoseBoneMove();
        this.boneMoveDrag = null;
        this.endPoseControlUndo();
        this.applyPose(this.progress);
        this.syncPoseControlsToCurrentBone();
        this.refreshRigOverlays();
        this.syncPatchJson();
        this.setStatus(`${actionLabel} ${this.boneDisplayName(bone.name || name)} pose`);
        return;
      }
      const actionLabel = this.boneMoveDrag.gizmoMode === "rotate" ? "Rotated" : "Moved";
      this.boneMoveDrag = null;
      this.endPoseControlUndo();
      this.updateBoneRecordFromObject(bone.name);
      this.rebuildSkinnedSkeletons();
      this.applyPose(this.progress);
      this.refreshRigControls(bone.name || name, { stopPlacement: false });
      this.refreshRigOverlays();
      this.syncPatchJson();
      this.setStatus(`${actionLabel} ${this.boneDisplayName(bone.name || name)}`);
    },

    poseGizmoStartPose(name) {
      const keyedPose = this.interpolatedPoseForFrame?.(this.progress * this.timelineFrames)?.[name] || {};
      const manualPose = this.manualPose.get(name) || {};
      return {
        x: finitePoseValue(manualPose.x ?? keyedPose.x),
        y: finitePoseValue(manualPose.y ?? keyedPose.y),
        z: finitePoseValue(manualPose.z ?? keyedPose.z),
        px: finitePoseValue(manualPose.px ?? keyedPose.px),
        py: finitePoseValue(manualPose.py ?? keyedPose.py),
        pz: finitePoseValue(manualPose.pz ?? keyedPose.pz)
      };
    },

    additivePoseFromRestRelativePose(name, pose = {}) {
      const bone = this.bones.get(name);
      const rest = this.bindPose.find((entry) => entry.object === bone);
      if (!bone || !rest || typeof this.ikPoseMapFromSolvedTransforms !== "function") {
        return null;
      }
      const solvedTransforms = new Map([[
        name,
        {
          position: new THREE.Vector3(
            rest.position.x + finitePoseValue(pose.px),
            rest.position.y + finitePoseValue(pose.py),
            rest.position.z + finitePoseValue(pose.pz)
          ),
          quaternion: rest.quaternion.clone().multiply(
            new THREE.Quaternion().setFromEuler(new THREE.Euler(
              finitePoseValue(pose.x),
              finitePoseValue(pose.y),
              finitePoseValue(pose.z),
              "XYZ"
            ))
          )
        }
      ]]);
      const additivePose = this.ikPoseMapFromSolvedTransforms([name], solvedTransforms).get(name);
      if (!additivePose) {
        return null;
      }
      const channels = Object.keys(pose).filter((channel) => CURVE_CHANNEL_KEYS.includes(channel));
      return Object.fromEntries(channels.map((channel) => [channel, finitePoseValue(additivePose[channel])]));
    },

    applyPoseBoneMove() {
      const drag = this.boneMoveDrag;
      if (!drag?.bone || drag.mode !== "pose") {
        return;
      }
      const relativePose = drag.gizmoMode === "rotate"
        ? this.getBoneRelativePose?.(drag.name) || {}
        : null;
      const nextPose = drag.gizmoMode === "rotate"
        ? {
          ...(drag.startManualPose || {}),
          x: finitePoseValue(relativePose.x ?? drag.startPose?.x),
          y: finitePoseValue(relativePose.y ?? drag.startPose?.y),
          z: finitePoseValue(relativePose.z ?? drag.startPose?.z)
        }
        : {
          ...(drag.startManualPose || {}),
          px: finitePoseValue((drag.startManualPose?.px || 0) + drag.bone.position.x - drag.startPosition.x),
          py: finitePoseValue((drag.startManualPose?.py || 0) + drag.bone.position.y - drag.startPosition.y),
          pz: finitePoseValue((drag.startManualPose?.pz || 0) + drag.bone.position.z - drag.startPosition.z)
        };
      const constrainedPose = this.clampPoseWithJointConstraint?.(drag.name, nextPose) || nextPose;
      if (drag.gizmoMode === "rotate") {
        for (const channel of ["x", "y", "z"]) {
          if (Math.abs(finitePoseValue(constrainedPose[channel]) - finitePoseValue(drag.startPose?.[channel])) > 0.00001) {
            this.markJointConstraintPoseChannelEdited?.(channel, drag.name);
          }
        }
      }
      const replaceBaseClip = this.poseKeyframeMode === "replace" && this.poseKeyframes.size > 0 && !this.poseKeyframesGenerated;
      const storeAsAdditive = this.actorTarget?.mode !== "bird-flap" && !replaceBaseClip;
      const frame = this.currentFrame?.() ?? Math.round((this.progress || 0) * (this.timelineFrames || 0));
      const convertRotationToAdditive = storeAsAdditive && drag.gizmoMode === "rotate";
      for (const [name, pose] of this.mirroredBoneEntries(drag.name, constrainedPose)) {
        const rotationPose = { x: pose.x, y: pose.y, z: pose.z };
        const additiveRotationPose = convertRotationToAdditive
          ? this.additivePoseFromRestRelativePose(name, rotationPose)
            || this.adaptivePoseFromAbsolutePose?.(frame, name, rotationPose)
            || null
          : null;
        const storedPose = additiveRotationPose
          ? { ...pose, ...additiveRotationPose }
          : pose;
        this.manualPose.set(name, { ...storedPose });
        if (storeAsAdditive) {
          this.manualPoseAdditiveNames?.add?.(name);
        } else {
          this.manualPoseAdditiveNames?.delete?.(name);
        }
        this.manualPoseEditedChannels?.set?.(name, new Set(Object.keys(constrainedPose)));
      }
      if (this.poseBoneSelect?.value === drag.name) {
        this.setPoseControlsFromPose(constrainedPose, drag.name);
      }
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        record.object.skeleton?.update?.();
      }
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLayerValues();
      if (this.boneLabelToggle?.checked) {
        this.updateBoneLabels();
      }
      this.syncPatchJson();
    },

    refreshRigOverlays() {
      this.updateSkeletonHelper?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBonePickerOverlay?.();
      this.updateBoneLabels?.();
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
    },

    applyRigBones(rigBones) {
      if (!Array.isArray(rigBones)) {
        return;
      }
      for (const definition of rigBones) {
        const name = this.sanitizeNewBoneName(definition?.name);
        const parent = this.sanitizeNewBoneName(definition?.parent);
        if (definition?.role === "rootMotion") {
          const hips = this.rootMotionUnbakeHipBone?.();
          const root = this.ensureRootMotionUnbakeBone?.(hips, { name });
          if (root) {
            const record = this.virtualBones.find((bone) => bone.name === root.name);
            if (record) {
              record.role = "rootMotion";
            }
          }
          continue;
        }
        if (!name || !parent || this.bones.has(name)) {
          continue;
        }
        this.addVirtualBone({
          name,
          parent,
          position: Array.isArray(definition.position) ? definition.position : [0, -0.12, 0],
          rotation: Array.isArray(definition.rotation) ? definition.rotation : [0, 0, 0]
        }, { sync: false, select: false });
      }
    },

    refreshRigControls(activeBone = this.activeBoneName, options = {}) {
      this.populateBoneSelect();
      if (activeBone && this.bones.has(activeBone)) {
        this.setActiveBone(activeBone, options);
      }
      this.renderAddBoneParentOptions();
      this.renderBoneChainOptions();
      this.renderAddBoneChainMemberOptions();
    },

    clearActiveBone({ stopPlacement = true } = {}) {
      if (stopPlacement) {
        this.setBonePlacementPending(false);
        this.boneMoveGizmoArmed = false;
      }
      this.activeBoneName = "";
      this.clearJointConstraintEditedPoseChannels?.("");
      this.clearSelectedBoneChainState?.();
      if (this.boneSelect && [...this.boneSelect.options].some((option) => option.value === "")) {
        this.boneSelect.value = "";
      }
      if (this.poseBoneSelect && [...this.poseBoneSelect.options].some((option) => option.value === "")) {
        this.poseBoneSelect.value = "";
      }
      for (const option of Array.from(this.addBoneChainMembersSelect?.options || [])) {
        option.selected = false;
      }
      this.syncPoseControls();
      this.updateRigBoneList();
      this.updateTimelineKeyMarkers();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.renderAddBoneParentOptions();
      this.syncBoneEditorControls("");
      this.syncJointConstraintControls?.();
      this.renderBoneChainOptions();
      this.renderAddBoneChainMemberOptions();
      this.updateBoneMoveGizmo();
      this.updateIkMoveGizmo?.();
      this.updateSelectionInfluences();
      this.syncJointConstraintControls?.();
    },

    setActiveBone(name, {
      stopPlacement = true,
      selectedBoneChainRootName = "",
      clearBoneChain = false,
      suppressBoneChainAutoSelect = false,
      preserveBoneChainMemberSelection = false
    } = {}) {
      name = this.canonicalMirrorBone(name);
      if (!name) {
        this.clearActiveBone({ stopPlacement });
        return;
      }
      if (!this.bones.has(name)) {
        return;
      }
      const previousName = this.activeBoneName;
      if (stopPlacement) {
        this.setBonePlacementPending(false);
        if (previousName !== name) {
          this.boneMoveGizmoArmed = false;
        }
      }
      this.activeBoneName = name;
      if (previousName !== name) {
        this.clearJointConstraintEditedPoseChannels?.(name);
      }
      if (clearBoneChain) {
        this.selectedBoneChainRootName = "";
        this.chainBoneSelectionMode = "none";
        this.ikEndBoneName = "";
        for (const option of Array.from(this.addBoneChainMembersSelect?.options || [])) {
          option.selected = false;
        }
      } else {
        const chainRoot = suppressBoneChainAutoSelect ? "" : selectedBoneChainRootName || this.customBoneRootName(name);
        if (chainRoot) {
          this.selectedBoneChainRootName = chainRoot;
        }
      }
      if (this.boneSelect.value !== name && [...this.boneSelect.options].some((option) => option.value === name)) {
        this.boneSelect.value = name;
      }
      if (this.poseBoneSelect.value !== name && [...this.poseBoneSelect.options].some((option) => option.value === name)) {
        this.poseBoneSelect.value = name;
      }
      this.syncPoseControls();
      this.updateRigBoneList();
      this.updateTimelineKeyMarkers();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.renderAddBoneParentOptions();
      this.syncBoneEditorControls(name);
      this.syncJointConstraintControls?.();
      this.renderBoneChainOptions();
      if (!preserveBoneChainMemberSelection) {
        this.renderAddBoneChainMemberOptions();
      } else {
        this.updateRedistributeChainButtonState?.();
      }
      this.updateBoneMoveGizmo();
      this.updateIkMoveGizmo?.();
      this.updateSelectionInfluences();
      this.syncJointConstraintControls?.();
    }
  });
}
