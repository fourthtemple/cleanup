import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { exportMixamoCleanupFbx, fromThreeObject, normalizeFbxScene } from "@fourthtemple/fbx-exporter";
import {
  createStaticMeshFbxDocument,
  writeStaticMeshFbx
} from "@fourthtemple/fbx-exporter/document/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function installFbxLoaderNodeShims() {
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.window.URL ||= {};
  globalThis.window.URL.createObjectURL ||= () => "";
  globalThis.window.URL.revokeObjectURL ||= () => {};
  const imageElement = () => {
    const listeners = new Map();
    const image = {
      tagName: "img",
      width: 1,
      height: 1,
      complete: true,
      style: {},
      setAttribute() {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      dispatchEvent(event) {
        listeners.get(event?.type)?.(event);
      }
    };
    Object.defineProperty(image, "src", {
      get() {
        return this._src || "";
      },
      set(value) {
        this._src = value;
        queueMicrotask(() => listeners.get("load")?.({ type: "load", target: image }));
      }
    });
    return image;
  };
  globalThis.Blob ||= class Blob {
    constructor(parts = [], options = {}) {
      this.parts = parts;
      this.type = options.type || "";
      this.size = parts.reduce((sum, part) => sum + (part?.byteLength || part?.length || 0), 0);
    }
  };
  globalThis.document ||= {
    createElementNS(_namespace, tagName) {
      if (String(tagName).toLowerCase() === "img") {
        return imageElement();
      }
      return {
        tagName,
        style: {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getContext() { return null; }
      };
    },
    createElement(tagName) {
      return this.createElementNS("", tagName);
    }
  };
}

function readArrayBuffer(filePath) {
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function loadFbx(filePath) {
  installFbxLoaderNodeShims();
  const loader = new FBXLoader();
  return loader.parse(readArrayBuffer(filePath), `${path.dirname(filePath)}${path.sep}`);
}

function firstAnimation(scene) {
  const clip = scene.animations?.[0];
  if (!clip) {
    throw new Error("No animation clip was found in the FBX.");
  }
  return clip;
}

function collectBones(root) {
  const bones = new Map();
  root.traverse((object) => {
    if (object.isBone) bones.set(object.name, object);
  });
  return bones;
}

function resolveMapName(map, requestedName) {
  if (map.has(requestedName)) return requestedName;
  const suffix = `:${requestedName}`;
  const match = [...map.keys()].find((name) => name.endsWith(suffix) || name.endsWith(requestedName));
  return match || requestedName;
}

function pngCount(bytes) {
  let count = 0;
  for (let index = 0; index < bytes.length - 8; index += 1) {
    if (
      bytes[index] === 0x89
      && bytes[index + 1] === 0x50
      && bytes[index + 2] === 0x4e
      && bytes[index + 3] === 0x47
      && bytes[index + 4] === 0x0d
      && bytes[index + 5] === 0x0a
      && bytes[index + 6] === 0x1a
      && bytes[index + 7] === 0x0a
    ) {
      count += 1;
    }
  }
  return count;
}

function jpgCount(bytes) {
  let count = 0;
  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) {
      count += 1;
    }
  }
  return count;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function embeddedPngDimensions(bytes, offset) {
  if (offset + 24 > bytes.length) return null;
  return {
    width: (
      (bytes[offset + 16] << 24)
      | (bytes[offset + 17] << 16)
      | (bytes[offset + 18] << 8)
      | bytes[offset + 19]
    ) >>> 0,
    height: (
      (bytes[offset + 20] << 24)
      | (bytes[offset + 21] << 16)
      | (bytes[offset + 22] << 8)
      | bytes[offset + 23]
    ) >>> 0
  };
}

function embeddedJpegDimensions(bytes, offset, end) {
  let cursor = offset + 2;
  while (cursor < end - 9) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    while (bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (cursor + 2 > end) return null;
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > end) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: (bytes[cursor + 3] << 8) | bytes[cursor + 4],
        width: (bytes[cursor + 5] << 8) | bytes[cursor + 6]
      };
    }
    cursor += length;
  }
  return null;
}

function sortEmbeddedTexturePayloads(payloads) {
  return [...payloads].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    return (areaB - areaA) || (b.content.byteLength - a.content.byteLength);
  });
}

function embeddedTexturePayloads(bytes) {
  const payloads = [];
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const matchesAt = (index, signature) => signature.every((value, offset) => bytes[index + offset] === value);
  for (let index = 0; index < bytes.length - 8; index += 1) {
    if (matchesAt(index, pngSignature)) {
      for (let cursor = index + 8; cursor < bytes.length - 12;) {
        const length = (
          (bytes[cursor] << 24)
          | (bytes[cursor + 1] << 16)
          | (bytes[cursor + 2] << 8)
          | bytes[cursor + 3]
        ) >>> 0;
        const type = String.fromCharCode(bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]);
        cursor += 12 + length;
        if (type === "IEND" && cursor <= bytes.length) {
          const content = bytes.subarray(index, cursor).slice();
          const dimensions = embeddedPngDimensions(bytes, index);
          payloads.push({
            content,
            mimeType: "image/png",
            src: `data:image/png;base64,${bytesToBase64(content)}`,
            width: dimensions?.width || 0,
            height: dimensions?.height || 0
          });
          index = cursor - 1;
          break;
        }
      }
    } else if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) {
      for (let cursor = index + 2; cursor < bytes.length - 1; cursor += 1) {
        if (bytes[cursor] === 0xff && bytes[cursor + 1] === 0xd9) {
          const content = bytes.subarray(index, cursor + 2).slice();
          const dimensions = embeddedJpegDimensions(bytes, index, cursor + 2);
          if (!dimensions?.width || !dimensions?.height) {
            index = cursor + 1;
            break;
          }
          payloads.push({
            content,
            mimeType: "image/jpeg",
            src: `data:image/jpeg;base64,${bytesToBase64(content)}`,
            width: dimensions.width,
            height: dimensions.height
          });
          index = cursor + 1;
          break;
        }
      }
    }
  }
  return sortEmbeddedTexturePayloads(payloads);
}

function attachEmbeddedPayloadsToScene(scene, bytes) {
  const payloads = embeddedTexturePayloads(bytes);
  if (!payloads.length) return 0;
  const textures = [];
  const seen = new Set();
  scene.traverse((object) => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const texture = material?.map;
      if (texture && !seen.has(texture.uuid)) {
        seen.add(texture.uuid);
        textures.push(texture);
      }
    }
  });
  textures.forEach((texture, index) => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    const extension = payload.mimeType === "image/png" ? "png" : "jpg";
    const fileName = texture.name && /\.[a-z0-9]+$/i.test(texture.name)
      ? texture.name
      : `embedded-texture-${index + 1}.${extension}`;
    texture.userData = {
      ...(texture.userData || {}),
      content: payload.content,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
      fileName,
      relativeFileName: fileName
    };
  });
  return Math.min(textures.length, payloads.length);
}

function quaternionFromFbxEulerDegrees(degrees = [0, 0, 0], order = "XYZ") {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(degrees[0] || 0),
    THREE.MathUtils.degToRad(degrees[1] || 0),
    THREE.MathUtils.degToRad(degrees[2] || 0),
    order
  ));
}

function applyImportedFbxRotationMetadata(root) {
  root.traverse((object) => {
    const transformData = object.userData?.transformData;
    if (!transformData) return;
    if (transformData.eulerOrder) {
      object.userData.fbxRotationOrder = transformData.eulerOrder;
    }
    if (transformData.preRotation) {
      object.userData.preRotation = [...transformData.preRotation];
    }
    if (transformData.postRotation) {
      object.userData.postRotation = [...transformData.postRotation];
    }
  });
}

function stripImportedFbxRotationMetadata(root) {
  root.traverse((object) => {
    delete object.userData?.fbxRotationOrder;
    delete object.userData?.rotationOrder;
    delete object.userData?.preRotation;
    delete object.userData?.postRotation;
  });
}

function forceXyzRotationOrder(root) {
  root.traverse((object) => {
    if (object.rotation) object.rotation.order = "XYZ";
    if (object.userData) object.userData.fbxRotationOrder = "XYZ";
  });
}

function buildTransformDataByBone(root) {
  const data = new Map();
  root.traverse((object) => {
    if (!object.isBone || !object.userData?.transformData) return;
    data.set(object.name, object.userData.transformData);
  });
  return data;
}

function transformQuaternionTracksToFbxLocalSpace(clip, transformDataByBone) {
  const tracks = clip.tracks.map((track) => {
    if (!track.ValueTypeName?.toLowerCase?.().includes("quaternion") && track.getValueSize?.() !== 4) {
      return track;
    }
    const boneName = [...transformDataByBone.keys()].find((name) => (
      track.name === `${name}.quaternion`
      || track.name.endsWith(`:${name}.quaternion`)
      || track.name.endsWith(`bones[${name}].quaternion`)
    ));
    const transformData = transformDataByBone.get(boneName);
    if (!transformData?.preRotation && !transformData?.postRotation) {
      return track;
    }
    const pre = quaternionFromFbxEulerDegrees(transformData.preRotation, "XYZ").invert();
    const post = quaternionFromFbxEulerDegrees(transformData.postRotation, "XYZ");
    const values = new Float32Array(track.values.length);
    const desired = new THREE.Quaternion();
    const local = new THREE.Quaternion();
    for (let index = 0; index < track.values.length; index += 4) {
      desired.fromArray(track.values, index);
      local.copy(pre).multiply(desired).multiply(post);
      local.toArray(values, index);
    }
    const converted = new THREE.QuaternionKeyframeTrack(track.name, track.times, values);
    converted.setInterpolation(track.getInterpolation());
    return converted;
  });
  clip.tracks = tracks;
  return clip;
}

function samplePose(scene, clip, time) {
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(time);
  scene.updateMatrixWorld(true);
  const bones = collectBones(scene);
  const pose = new Map();
  for (const [name, bone] of bones) {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    bone.matrixWorld.decompose(position, quaternion, scale);
    pose.set(name, { position, quaternion, scale });
  }
  mixer.stopAllAction();
  return pose;
}

function angleDegrees(a, b) {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return THREE.MathUtils.radToDeg(2 * Math.acos(dot));
}

function positionDistance(a, b) {
  return a.distanceTo(b);
}

function trackForBone(clip, boneName, binding) {
  const direct = `bones[${boneName}].${binding}`;
  return clip.tracks.find((track) => (
    track.name.endsWith(direct)
    || track.name === `${boneName}.${binding}`
    || track.name === `mixamorig${boneName}.${binding}`
    || track.name.endsWith(`:${boneName}.${binding}`)
    || track.name.endsWith(`${boneName}.${binding}`)
    || track.name.endsWith(`:${boneName}.${binding}`)
  ));
}

function firstTrackVector(track, size) {
  if (!track) return null;
  return Array.from(track.values.slice(0, size)).map((value) => Number(value.toFixed(5)));
}

function compareTrackFirstValues(sourceClip, reloadClip, boneNames) {
  return boneNames.map((boneName) => {
    const sourceQuat = trackForBone(sourceClip, boneName, "quaternion");
    const reloadQuat = trackForBone(reloadClip, boneName, "quaternion");
    const sourcePos = trackForBone(sourceClip, boneName, "position");
    const reloadPos = trackForBone(reloadClip, boneName, "position");
    return {
      bone: boneName,
      sourceQuaternion0: firstTrackVector(sourceQuat, 4),
      reloadQuaternion0: firstTrackVector(reloadQuat, 4),
      sourcePosition0: firstTrackVector(sourcePos, 3),
      reloadPosition0: firstTrackVector(reloadPos, 3)
    };
  });
}

function comparePoses(sourcePose, reloadPose, boneNames) {
  return boneNames.map((boneName) => {
    const sourceName = resolveMapName(sourcePose, boneName);
    const reloadName = resolveMapName(reloadPose, boneName);
    const source = sourcePose.get(sourceName);
    const reload = reloadPose.get(reloadName);
    if (!source || !reload) {
      return { bone: boneName, missing: !source ? "source" : "reload" };
    }
    return {
      bone: boneName,
      worldPositionError: Number(positionDistance(source.position, reload.position).toFixed(5)),
      worldRotationErrorDegrees: Number(angleDegrees(source.quaternion, reload.quaternion).toFixed(5))
    };
  });
}

function summarizeScene(scene) {
  let skinnedMeshes = 0;
  let meshes = 0;
  let materialsWithMap = 0;
  const materials = [];
  scene.traverse((object) => {
    if (object.isSkinnedMesh) skinnedMeshes += 1;
    if (object.isMesh) meshes += 1;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material?.map) materialsWithMap += 1;
      if (material) {
        const texture = material.map || null;
        const image = texture?.image || texture?.source?.data || null;
        materials.push({
          object: object.name || "",
          material: material.name || "",
          hasMap: Boolean(texture),
          mapName: texture?.name || "",
          imageType: image?.constructor?.name || "",
          imageSrc: image?.src || texture?.userData?.src || "",
          imageWidth: image?.width || image?.naturalWidth || 0,
          imageHeight: image?.height || image?.naturalHeight || 0
        });
      }
    }
  });
  return {
    meshes,
    skinnedMeshes,
    materialsWithMap,
    materials,
    animations: scene.animations?.length || 0,
    tracks: scene.animations?.[0]?.tracks.length || 0
  };
}

function summarizeExporterTextureState(scene) {
  const threeTextures = [];
  scene.traverse((object) => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material?.map) continue;
      const texture = material.map;
      const content = texture.userData?.content || texture.content || texture.userData?.bytes || texture.bytes;
      threeTextures.push({
        object: object.name || "",
        material: material.name || "",
        texture: texture.name || "",
        fileName: texture.userData?.fileName || texture.fileName || "",
        relativeFileName: texture.userData?.relativeFileName || texture.relativeFileName || "",
        mimeType: texture.userData?.mimeType || texture.mimeType || "",
        contentBytes: content?.byteLength || content?.length || 0
      });
    }
  });
  const sceneObject = fromThreeObject(scene, { embedTextures: true });
  const normalized = normalizeFbxScene(sceneObject, { embedTextures: true });
  const normalizedTextures = [];
  for (const mesh of normalized.meshes || []) {
    for (const material of mesh.materials || []) {
      for (const texture of material.textures || []) {
      normalizedTextures.push({
        mesh: mesh.name || "",
        material: material.name || "",
        texture: texture.name || "",
        property: texture.property || "",
        fileName: texture.fileName || "",
        relativeFileName: texture.relativeFileName || "",
        mimeType: texture.mimeType || "",
        contentBytes: texture.content?.byteLength || texture.content?.length || 0,
        contentPngCount: texture.content ? pngCount(texture.content) : 0,
        contentJpgCount: texture.content ? jpgCount(texture.content) : 0,
        contentHead: texture.content
          ? Array.from(texture.content.subarray?.(0, 12) || []).map((value) => value.toString(16).padStart(2, "0")).join(" ")
          : ""
      });
      }
    }
  }
  const directWrite = writeStaticMeshFbx(sceneObject, { embedTextures: true });
  return {
    threeTextures,
    normalizedTextures,
    documentContentNodes: countDocumentContentNodes(sceneObject),
    directWrite: {
      bytes: directWrite.byteLength,
      pngCount: pngCount(directWrite),
      jpgCount: jpgCount(directWrite)
    }
  };
}

function countDocumentContentNodes(sceneObject) {
  const nodes = createStaticMeshFbxDocument(sceneObject, { embedTextures: true });
  let count = 0;
  let bytes = 0;
  const visit = (node) => {
    if (node?.name === "Content") {
      count += 1;
      for (const property of node.properties || []) {
        bytes += property?.value?.byteLength || property?.value?.length || 0;
      }
    }
    for (const child of node?.children || []) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return { count, bytes };
}

function outputJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

const input = path.resolve(repoRoot, argValue("input", "assets/models/animation-library/cat/dying-4.fbx"));
const output = path.resolve(repoRoot, argValue("output", "tmp/verify-roundtrip/cat-dying-4-roundtrip.fbx"));
const frameRate = Number(argValue("frame-rate", "30"));
const poseTime = Number(argValue("time", "0"));
const variant = argValue("variant", "plain");
const inspectOnly = process.argv.includes("--inspect-only");
const attachEmbeddedTextures = process.argv.includes("--attach-embedded-textures");
const bones = String(argValue("bones", "Hips,Spine,Spine1,Neck,Head,LeftShoulder,LeftArm,LeftForeArm,RightShoulder,RightArm,RightForeArm,LeftUpLeg,LeftLeg,RightUpLeg,RightLeg"))
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const sourceBytes = fs.readFileSync(input);
const sourceScene = loadFbx(input);
const attachedEmbeddedTextures = attachEmbeddedTextures ? attachEmbeddedPayloadsToScene(sourceScene, sourceBytes) : 0;
if (inspectOnly) {
  outputJson({
    input,
    bytes: sourceBytes.byteLength,
    pngCount: pngCount(sourceBytes),
    jpgCount: jpgCount(sourceBytes),
    attachedEmbeddedTextures,
    scene: summarizeScene(sourceScene),
    exporterTextureState: summarizeExporterTextureState(sourceScene)
  });
  process.exit(0);
}
const sourceClip = firstAnimation(sourceScene).clone();
if (variant === "plain") {
  stripImportedFbxRotationMetadata(sourceScene);
} else if (variant === "force-xyz") {
  stripImportedFbxRotationMetadata(sourceScene);
  forceXyzRotationOrder(sourceScene);
} else if (variant === "metadata") {
  applyImportedFbxRotationMetadata(sourceScene);
} else if (variant === "metadata-local-curves") {
  applyImportedFbxRotationMetadata(sourceScene);
  transformQuaternionTracksToFbxLocalSpace(sourceClip, buildTransformDataByBone(sourceScene));
} else {
  throw new Error(`Unknown --variant=${variant}`);
}
const exportBytes = exportMixamoCleanupFbx({
  object3D: sourceScene,
  animations: [sourceClip],
  frameRate
}, {
  embedTextures: true,
  textureTransformMode: "blender",
  bakeAnimations: false
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.from(exportBytes));

const reloadBytes = fs.readFileSync(output);
const reloadScene = loadFbx(output);
const reloadClip = firstAnimation(reloadScene);
const sourcePose = samplePose(sourceScene, sourceClip, poseTime);
const reloadPose = samplePose(reloadScene, reloadClip, poseTime);

outputJson({
  input,
  output,
  frameRate,
  variant,
  poseTime,
  source: {
    bytes: sourceBytes.byteLength,
    pngCount: pngCount(sourceBytes),
    jpgCount: jpgCount(sourceBytes),
    scene: summarizeScene(sourceScene),
    attachedEmbeddedTextures,
    exporterTextureState: summarizeExporterTextureState(sourceScene)
  },
  reload: {
    bytes: reloadBytes.byteLength,
    pngCount: pngCount(reloadBytes),
    jpgCount: jpgCount(reloadBytes),
    scene: summarizeScene(reloadScene)
  },
  trackFirstValues: compareTrackFirstValues(sourceClip, reloadClip, bones),
  poseErrors: comparePoses(sourcePose, reloadPose, bones)
});
