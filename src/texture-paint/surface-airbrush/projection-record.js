import * as THREE from "../../../node_modules/three/build/three.webgpu.js";

const _world = new THREE.Vector3();
const _view = new THREE.Vector3();
const _clip = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _normal4 = new THREE.Vector4();
const _normalMatrix = new THREE.Matrix3();
const _boneMatrix = new THREE.Matrix4();
const _skinMatrix = new THREE.Matrix4();

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteComponentId(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : -1;
}

function bufferAttributeComponent(attribute = null, vertexIndex = 0, component = 0, fallback = 0) {
  if (!attribute || vertexIndex < 0 || component < 0) {
    return fallback;
  }
  if (typeof attribute.getComponent === "function") {
    return finiteNumber(attribute.getComponent(vertexIndex, component), fallback);
  }
  const itemSize = Math.max(1, Math.floor(Number(attribute.itemSize) || 1));
  return finiteNumber(attribute.array?.[vertexIndex * itemSize + component], fallback);
}

function addWeightedMatrix(target = null, source = null, weight = 0) {
  const targetElements = target?.elements || null;
  const sourceElements = source?.elements || null;
  if (!targetElements || !sourceElements || !Number.isFinite(weight) || weight === 0) {
    return false;
  }
  for (let index = 0; index < 16; index += 1) {
    targetElements[index] += sourceElements[index] * weight;
  }
  return true;
}

function skinLocalNormalForVertex(object = null, geometry = null, vertexIndex = 0, normal = null) {
  const skinIndex = geometry?.attributes?.skinIndex || null;
  const skinWeight = geometry?.attributes?.skinWeight || null;
  const skeleton = object?.skeleton || null;
  if (!normal || object?.isSkinnedMesh !== true || !skinIndex || !skinWeight || !skeleton) {
    return normal;
  }
  skeleton.update?.();
  _skinMatrix.set(
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0
  );
  let totalWeight = 0;
  const influenceCount = Math.max(
    Math.floor(Number(skinIndex.itemSize) || 0),
    Math.floor(Number(skinWeight.itemSize) || 0),
    4
  );
  for (let influence = 0; influence < influenceCount; influence += 1) {
    const weight = bufferAttributeComponent(skinWeight, vertexIndex, influence, 0);
    if (!Number.isFinite(weight) || Math.abs(weight) <= 0.000001) {
      continue;
    }
    const boneIndex = Math.floor(bufferAttributeComponent(skinIndex, vertexIndex, influence, -1));
    if (!Number.isFinite(boneIndex) || boneIndex < 0) {
      continue;
    }
    if (typeof skeleton.getBoneMatrix === "function") {
      skeleton.getBoneMatrix(boneIndex, _boneMatrix);
    } else if (skeleton.boneMatrices?.length >= boneIndex * 16 + 16) {
      _boneMatrix.fromArray(skeleton.boneMatrices, boneIndex * 16);
    } else {
      continue;
    }
    addWeightedMatrix(_skinMatrix, _boneMatrix, weight);
    totalWeight += Math.abs(weight);
  }
  if (totalWeight <= 0.000001) {
    return normal;
  }
  if (object.bindMatrix && object.bindMatrixInverse) {
    _skinMatrix.multiplyMatrices(object.bindMatrixInverse, _skinMatrix).multiply(object.bindMatrix);
  }
  _normal4.set(normal.x, normal.y, normal.z, 0).applyMatrix4(_skinMatrix);
  normal.set(_normal4.x, _normal4.y, _normal4.z);
  return normal.lengthSq() > 0.000001 ? normal.normalize() : normal;
}

export function vertexIndexAt(geometry = null, elementIndex = 0) {
  const index = geometry?.index || null;
  if (index && typeof index.getX === "function") {
    return Math.max(0, Math.floor(Number(index.getX(elementIndex)) || 0));
  }
  return Math.max(0, Math.floor(Number(elementIndex) || 0));
}

export function worldPositionForVertex(object = null, geometry = null, vertexIndex = 0) {
  const position = geometry?.attributes?.position || null;
  if (!object || !position) {
    return null;
  }
  _world.fromBufferAttribute(position, vertexIndex);
  if (typeof object.applyBoneTransform === "function") {
    object.applyBoneTransform(vertexIndex, _world);
  } else if (typeof object.boneTransform === "function") {
    object.boneTransform(vertexIndex, _world);
  }
  if (!Number.isFinite(_world.x) || !Number.isFinite(_world.y) || !Number.isFinite(_world.z)) {
    return null;
  }
  object.localToWorld?.(_world);
  return { x: _world.x, y: _world.y, z: _world.z };
}

export function viewNormalForVertex(object = null, geometry = null, vertexIndex = 0, editor = null) {
  const normal = geometry?.attributes?.normal || null;
  const camera = editor?.camera || null;
  if (!object || !normal || !camera) {
    return null;
  }
  _normal.fromBufferAttribute(normal, vertexIndex);
  if (!_normal.lengthSq()) {
    return null;
  }
  skinLocalNormalForVertex(object, geometry, vertexIndex, _normal);
  _normalMatrix.getNormalMatrix(object.matrixWorld);
  _normal.applyMatrix3(_normalMatrix).normalize();
  _normal.transformDirection(camera.matrixWorldInverse);
  return Number.isFinite(_normal.x) && Number.isFinite(_normal.y) && Number.isFinite(_normal.z)
    ? { x: _normal.x, y: _normal.y, z: _normal.z }
    : null;
}

export function screenPointForWorld(editor = null, world = null) {
  const camera = editor?.camera || null;
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  if (!camera || !rect || !Number.isFinite(world?.x) || !Number.isFinite(world?.y) || !Number.isFinite(world?.z)) {
    return null;
  }
  _view.set(world.x, world.y, world.z).applyMatrix4(camera.matrixWorldInverse);
  const viewX = _view.x;
  const viewY = _view.y;
  const viewZ = _view.z;
  _clip.set(viewX, viewY, viewZ).applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(_clip.x) || !Number.isFinite(_clip.y) || !Number.isFinite(viewZ)) {
    return null;
  }
  return {
    x: (_clip.x * 0.5 + 0.5) * rect.width,
    y: (-_clip.y * 0.5 + 0.5) * rect.height,
    z: Number.isFinite(_clip.z) ? _clip.z : 0,
    viewX,
    viewY,
    viewZ,
    clipW: camera.isPerspectiveCamera ? Math.abs(viewZ) : 1
  };
}

export function roundedSurfaceKeyNumber(value = null, scale = 1000000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * scale) : "n";
}

export function matrixSurfaceKey(matrix = null, scale = 1000000) {
  const elements = matrix?.elements || matrix || null;
  if (!elements?.length) {
    return "";
  }
  return Array.from(elements)
    .map((value) => roundedSurfaceKeyNumber(value, scale))
    .join(",");
}

function arraySurfaceKey(values = null, scale = 100000) {
  if (!values?.length) {
    return "";
  }
  return Array.from(values)
    .map((value) => roundedSurfaceKeyNumber(value, scale))
    .join(",");
}

function sourceObjectSurfaceProjectionKey(sourceObject = null) {
  const geometry = sourceObject?.geometry || null;
  return [
    sourceObject?.uuid || sourceObject?.id || sourceObject?.name || "object",
    geometry?.uuid || geometry?.id || "geometry",
    Number(geometry?.attributes?.position?.version) || 0,
    Number(geometry?.attributes?.normal?.version) || 0,
    Number(geometry?.attributes?.uv?.version) || 0,
    Number(geometry?.index?.version) || 0,
    matrixSurfaceKey(sourceObject?.matrixWorld),
    arraySurfaceKey(sourceObject?.skeleton?.boneMatrices, 10000),
    arraySurfaceKey(sourceObject?.morphTargetInfluences, 100000)
  ].join("|");
}

export function surfaceProjectionFrameKey(editor = null, sourceObjects = []) {
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  const camera = editor?.camera || null;
  camera?.updateMatrixWorld?.(true);
  const objectKeys = [];
  for (const sourceObject of Array.isArray(sourceObjects) ? sourceObjects : []) {
    sourceObject?.updateMatrixWorld?.(true);
    objectKeys.push(sourceObjectSurfaceProjectionKey(sourceObject));
  }
  return [
    rect?.width || editor?.canvas?.clientWidth || editor?.canvas?.width || 0,
    rect?.height || editor?.canvas?.clientHeight || editor?.canvas?.height || 0,
    Number(editor?.textureAirbrushCameraPrewarmSerial) || 0,
    matrixSurfaceKey(camera?.matrixWorldInverse),
    matrixSurfaceKey(camera?.projectionMatrix),
    objectKeys.join(";")
  ].join(":");
}

export function surfaceProjectionRecord(editor = null, sourceObject = null, geometry = null, vertexIndex = 0, componentId = -1) {
  const uvAttribute = geometry?.attributes?.uv || null;
  const world = worldPositionForVertex(sourceObject, geometry, vertexIndex);
  const screen = screenPointForWorld(editor, world);
  const normal = viewNormalForVertex(sourceObject, geometry, vertexIndex, editor);
  const resolvedComponentId = finiteComponentId(componentId);
  return {
    valid: Boolean(screen),
    uv: uvAttribute && typeof uvAttribute.getX === "function" && typeof uvAttribute.getY === "function"
      ? { x: finiteNumber(uvAttribute.getX(vertexIndex), 0), y: finiteNumber(uvAttribute.getY(vertexIndex), 0) }
      : null,
    world,
    view: screen ? { x: screen.viewX, y: screen.viewY, z: screen.viewZ } : null,
    screen: screen ? { x: screen.x, y: screen.y, z: screen.z } : null,
    screenPoint: screen,
    normal,
    componentId: resolvedComponentId,
    componentAttribute: resolvedComponentId >= 0 ? resolvedComponentId + 1 : 0
  };
}

export function ensureSurfaceProjectionAttributes(entry = null, editor = null, options = {}) {
  const sourceObject = entry?.sourceObject || null;
  const sourceGeometry = sourceObject?.geometry || entry?.geometry || null;
  const rasterGeometry = entry?.mesh?.geometry || null;
  const position = sourceGeometry?.attributes?.position || null;
  if (!sourceObject || !sourceGeometry || !rasterGeometry || !position || !editor?.camera) {
    return false;
  }
  sourceObject.updateMatrixWorld?.(true);
  editor.camera.updateMatrixWorld?.(true);
  const vertexCount = Math.max(0, Math.floor(Number(position.count) || 0));
  let viewAttribute = rasterGeometry.getAttribute?.("paintView") || null;
  let screenAttribute = rasterGeometry.getAttribute?.("paintScreen") || null;
  let normalAttribute = rasterGeometry.getAttribute?.("paintNormal") || null;
  if (!viewAttribute || viewAttribute.count !== vertexCount) {
    viewAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    rasterGeometry.setAttribute("paintView", viewAttribute);
  }
  if (!screenAttribute || screenAttribute.count !== vertexCount) {
    screenAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    rasterGeometry.setAttribute("paintScreen", screenAttribute);
  }
  if (!normalAttribute || normalAttribute.count !== vertexCount) {
    normalAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    rasterGeometry.setAttribute("paintNormal", normalAttribute);
  }
  const projectionKey = [
    surfaceProjectionFrameKey(editor, [sourceObject]),
    String(options.componentKey || "")
  ].join("|");
  if (
    projectionKey
    && entry.texturePaintTslSurfaceProjectionKey === projectionKey
    && viewAttribute.count === vertexCount
    && screenAttribute.count === vertexCount
    && normalAttribute.count === vertexCount
  ) {
    return true;
  }
  const componentIds = options.componentState?.componentIds || null;
  const viewArray = viewAttribute.array;
  const screenArray = screenAttribute.array;
  const normalArray = normalAttribute.array;
  for (let index = 0; index < vertexCount; index += 1) {
    const record = surfaceProjectionRecord(editor, sourceObject, sourceGeometry, index, componentIds?.[index]);
    const offset = index * 3;
    if (record.valid) {
      viewArray[offset] = record.view.x;
      viewArray[offset + 1] = record.view.y;
      viewArray[offset + 2] = record.view.z;
      screenArray[offset] = record.screen.x;
      screenArray[offset + 1] = record.screen.y;
      screenArray[offset + 2] = record.componentAttribute;
      normalArray[offset] = finiteNumber(record.normal?.x, 0);
      normalArray[offset + 1] = finiteNumber(record.normal?.y, 0);
      normalArray[offset + 2] = finiteNumber(record.normal?.z, 1);
    } else {
      viewArray[offset] = 0;
      viewArray[offset + 1] = 0;
      viewArray[offset + 2] = 1000000;
      screenArray[offset] = -1000000;
      screenArray[offset + 1] = -1000000;
      screenArray[offset + 2] = record.componentAttribute;
      normalArray[offset] = 0;
      normalArray[offset + 1] = 0;
      normalArray[offset + 2] = -1;
    }
  }
  viewAttribute.needsUpdate = true;
  screenAttribute.needsUpdate = true;
  normalAttribute.needsUpdate = true;
  entry.texturePaintTslSurfaceProjectionKey = projectionKey;
  return true;
}
