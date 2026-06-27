import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';

const supportedExtensions = new Set(['glb', 'gltf', 'fbx', 'obj', 'dae', 'stl', 'ply', '3ds']);
const canvas = document.querySelector('#scene');
const statusEl = document.querySelector('#status');
const modelRootEl = document.querySelector('#modelRoot');
const modelListEl = document.querySelector('#modelList');
const modelCountEl = document.querySelector('#modelCount');
const searchInput = document.querySelector('#searchInput');
const refreshButton = document.querySelector('#refreshButton');
const resetButton = document.querySelector('#resetButton');
const wireframeInput = document.querySelector('#wireframeInput');
const autoRotateInput = document.querySelector('#autoRotateInput');
const spinAxisInput = document.querySelector('#spinAxisInput');
const lightInput = document.querySelector('#lightInput');
const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#fileInput');

let models = [];
let activeUrl = '';
let currentObject = null;
let currentMixer = null;
let currentFrame = null;
let lastFrameTime = 0;
const manifestUrl = new URL('./models.json', window.location.href);
manifestUrl.searchParams.set('v', '202606271725');

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(2.6, 1.8, 3.2);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.8, 0);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x39485d, 1.4);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
keyLight.position.set(4, 6, 5);
keyLight.castShadow = true;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8fc8ff, 0.7);
fillLight.position.set(-3, 3, -4);
scene.add(fillLight);

const ground = new THREE.GridHelper(12, 24, 0x405064, 0x263140);
ground.position.y = -0.01;
scene.add(ground);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getExtension(input) {
  return input.split('?')[0].split('.').pop().toLowerCase();
}

function normalizeModel(model) {
  const url = model.url || model.path || '';
  const decodedUrl = decodeURIComponent(url);
  const path = model.path || decodedUrl;
  const name = model.name || path.split('/').pop() || decodedUrl.split('/').pop() || 'Untitled model';
  const extension = (model.extension || getExtension(url || name)).toLowerCase();

  return {
    ...model,
    name,
    path,
    url,
    extension,
    size: Number(model.size || 0)
  };
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value && value.isTexture) value.dispose();
      });
      material.dispose();
    });
  });
}

function clearModel() {
  currentMixer = null;
  currentFrame = null;
  if (!currentObject) return;
  scene.remove(currentObject);
  disposeObject(currentObject);
  currentObject = null;
}

function prepareObject(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.filter(Boolean).forEach((material) => {
        material.side = THREE.DoubleSide;
        material.wireframe = wireframeInput.checked;
      });
    }
  });
}

function applyDefaultOrientation(object, extension) {
  if (extension !== 'dae') return;

  object.rotation.x -= Math.PI / 2;
  object.rotation.y += Math.PI;
  object.rotation.z += Math.PI;
  object.updateMatrixWorld(true);
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2.4 / maxDim;

  object.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(object);
  const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
  object.position.sub(scaledCenter);
  object.position.y -= scaledBox.min.y;

  const finalBox = new THREE.Box3().setFromObject(object);
  const finalSize = finalBox.getSize(new THREE.Vector3());
  const finalCenter = finalBox.getCenter(new THREE.Vector3());
  const radius = Math.max(finalSize.x, finalSize.y, finalSize.z) * 0.75 || 1;

  currentFrame = { center: finalCenter.clone(), radius };
  resetCamera();
}

function resetCamera() {
  if (!currentFrame) return;

  const { center, radius } = currentFrame;
  controls.target.copy(center);
  camera.position.set(center.x + radius * 1.8, center.y + radius * 1.2, center.z + radius * 2.2);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = Math.max(radius * 100, 100);
  camera.updateProjectionMatrix();
  controls.update();
}

function createCenteredPivot(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return object;

  const center = box.getCenter(new THREE.Vector3());
  const pivot = new THREE.Group();
  pivot.name = 'model-center-pivot';
  pivot.position.copy(center);
  object.position.sub(center);
  pivot.add(object);
  return pivot;
}

function setWireframe(enabled) {
  if (!currentObject) return;
  currentObject.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      material.wireframe = enabled;
    });
  });
}

function modelFromGeometry(geometry, name) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xd8dee9,
    roughness: 0.64,
    metalness: 0.05,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

function loadWith(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

async function loadObj(url) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const file = decodeURIComponent(url.split('/').pop());
  const mtlUrl = `${base}${encodeURIComponent(file.replace(/\.[^.]+$/, '.mtl'))}`;

  try {
    const materials = await loadWith(new MTLLoader().setPath(base), mtlUrl.replace(base, ''));
    materials.preload();
    return await loadWith(new OBJLoader().setMaterials(materials).setPath(base), file);
  } catch (error) {
    return loadWith(new OBJLoader(), url);
  }
}

async function parseLocalFile(file) {
  const extension = getExtension(file.name);
  const objectUrl = URL.createObjectURL(file);

  try {
    if (extension === 'glb' || extension === 'gltf') {
      const gltf = await loadWith(new GLTFLoader(), objectUrl);
      startAnimations(gltf.scene, gltf.animations);
      return gltf.scene;
    }
    if (extension === 'fbx') {
      const object = await loadWith(new FBXLoader(), objectUrl);
      startAnimations(object, object.animations);
      return object;
    }
    if (extension === 'obj') return loadWith(new OBJLoader(), objectUrl);
    if (extension === 'dae') {
      const collada = await loadWith(new ColladaLoader(), objectUrl);
      startAnimations(collada.scene, collada.animations || []);
      applyDefaultOrientation(collada.scene, extension);
      return collada.scene;
    }
    if (extension === 'stl') return modelFromGeometry(await loadWith(new STLLoader(), objectUrl), file.name);
    if (extension === 'ply') return modelFromGeometry(await loadWith(new PLYLoader(), objectUrl), file.name);
    if (extension === '3ds') return loadWith(new TDSLoader(), objectUrl);
    throw new Error(`Unsupported format: ${extension}`);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

function startAnimations(root, animations = []) {
  currentMixer = null;
  if (!animations.length) return;
  currentMixer = new THREE.AnimationMixer(root);
  animations.forEach((clip) => currentMixer.clipAction(clip).play());
}

async function loadModel(url, label = url) {
  const extension = getExtension(url);
  if (!supportedExtensions.has(extension)) {
    setStatus(`Unsupported model format: ${extension}`, true);
    return;
  }

  setStatus(`Loading ${label}...`);
  clearModel();
  activeUrl = url;
  renderModelList();

  try {
    let object;

    if (extension === 'glb' || extension === 'gltf') {
      const gltf = await loadWith(new GLTFLoader(), url);
      object = gltf.scene;
      startAnimations(object, gltf.animations);
    } else if (extension === 'fbx') {
      const loader = new FBXLoader();
      loader.setResourcePath(url.slice(0, url.lastIndexOf('/') + 1));
      object = await loadWith(loader, url);
      startAnimations(object, object.animations);
    } else if (extension === 'obj') {
      object = await loadObj(url);
    } else if (extension === 'dae') {
      const collada = await loadWith(new ColladaLoader(), url);
      object = collada.scene;
      startAnimations(object, collada.animations || []);
      applyDefaultOrientation(object, extension);
    } else if (extension === 'stl') {
      object = modelFromGeometry(await loadWith(new STLLoader(), url), label);
    } else if (extension === 'ply') {
      object = modelFromGeometry(await loadWith(new PLYLoader(), url), label);
    } else if (extension === '3ds') {
      const loader = new TDSLoader();
      loader.setResourcePath(url.slice(0, url.lastIndexOf('/') + 1));
      object = await loadWith(loader, url);
    }

    prepareObject(object);
    currentObject = createCenteredPivot(object);
    scene.add(currentObject);
    frameObject(currentObject);
    setStatus(`Loaded ${label}. Auto rotate spins the model around its center. Drag to rotate camera, scroll to zoom.`);
  } catch (error) {
    console.error(error);
    setStatus(`Could not load ${label}: ${error.message}`, true);
  }
}

function renderModelList() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = models.filter((model) => model.path.toLowerCase().includes(query));
  modelCountEl.textContent = `${filtered.length} model${filtered.length === 1 ? '' : 's'}`;
  modelListEl.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.textContent = query ? 'No matching models.' : 'No supported models found in the configured directory.';
    modelListEl.append(empty);
    return;
  }

  for (const model of filtered) {
    const button = document.createElement('button');
    button.className = `model-item${model.url === activeUrl ? ' is-active' : ''}`;
    button.type = 'button';

    const name = document.createElement('span');
    name.textContent = model.name;
    const detail = document.createElement('small');
    detail.textContent = `${model.path} · ${model.extension.toUpperCase()} · ${formatBytes(model.size)}`;

    button.append(name, detail);
    button.addEventListener('click', () => loadModel(model.url, model.path));
    modelListEl.append(button);
  }
}

function loadDefaultModel() {
  if (activeUrl || !models.length) return;

  const defaultModel = models.find((model) => model.extension === 'dae') || models[0];
  loadModel(defaultModel.url, defaultModel.path);
}

async function refreshModels() {
  setStatus('Loading model catalog...');
  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    models = (data.models || []).map(normalizeModel);
    modelRootEl.textContent = data.modelRoot || manifestUrl.pathname;
    renderModelList();
    if (models.length) {
      loadDefaultModel();
    } else {
      setStatus('No published models found. Add files to public/models and update models.json.');
    }
  } catch (error) {
    await refreshModelsFromServer(error);
  }
}

async function refreshModelsFromServer(manifestError) {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    models = (data.models || []).map(normalizeModel);
    modelRootEl.textContent = data.exists ? data.modelRoot : `Missing: ${data.modelRoot}`;
    renderModelList();
    if (models.length) {
      loadDefaultModel();
    } else {
      setStatus('No supported model files found.');
    }
  } catch (serverError) {
    console.warn('Static manifest load failed:', manifestError);
    console.warn('Local model API load failed:', serverError);
    models = [];
    modelRootEl.textContent = 'No model catalog available';
    renderModelList();
    setStatus('Could not load models.json or /api/models. Drag a model file here, or add a static model catalog.', true);
  }
}

async function handleFile(file) {
  const extension = getExtension(file.name);
  if (!supportedExtensions.has(extension)) {
    setStatus(`Unsupported file: ${file.name}`, true);
    return;
  }

  try {
    setStatus(`Loading ${file.name}...`);
    clearModel();
    activeUrl = '';
    const object = await parseLocalFile(file);
    prepareObject(object);
    currentObject = createCenteredPivot(object);
    scene.add(currentObject);
    frameObject(currentObject);
    renderModelList();
    setStatus(`Loaded ${file.name}. Auto rotate spins the model around its center. For textures and linked files, use the model directory server list.`);
  } catch (error) {
    console.error(error);
    setStatus(`Could not load ${file.name}: ${error.message}`, true);
  }
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

function animate(time) {
  resize();
  const delta = lastFrameTime ? (time - lastFrameTime) / 1000 : 0;
  lastFrameTime = time;
  controls.autoRotate = false;
  if (autoRotateInput.checked && currentObject) {
    currentObject.rotation[spinAxisInput.value] += delta * 0.9;
  }
  controls.update();
  if (currentMixer) currentMixer.update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

searchInput.addEventListener('input', renderModelList);
refreshButton.addEventListener('click', refreshModels);
resetButton.addEventListener('click', () => {
  if (currentObject) currentObject.rotation.set(0, 0, 0);
  resetCamera();
});
wireframeInput.addEventListener('change', () => setWireframe(wireframeInput.checked));
lightInput.addEventListener('input', () => {
  const value = Number(lightInput.value);
  hemiLight.intensity = value;
  keyLight.intensity = value;
});
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) handleFile(file);
  fileInput.value = '';
});

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
  });
}

dropzone.addEventListener('drop', (event) => {
  const [file] = event.dataTransfer.files;
  if (file) handleFile(file);
});

refreshModels();
requestAnimationFrame(animate);
