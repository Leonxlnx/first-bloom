// GPU cost benchmark: terrain + N instanced grass blades + sky, low camera.
import * as THREE from 'three';

export async function createWorld({ q }) {
  const N = +(q.get('blades') || 2000000);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 3000);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vD; void main(){ float h = max(vD.y, 0.0); vec3 c = mix(vec3(0.75,0.85,1.0), vec3(0.15,0.4,0.95), pow(h, 0.6)) * 2.0; gl_FragColor = vec4(c, 1.0); }`,
  }));
  scene.add(sky);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 256, 256).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a5a1a, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  const sun = new THREE.DirectionalLight(0xfff1d6, 4);
  sun.position.set(30, 40, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
  scene.add(sun, new THREE.HemisphereLight(0xbfdfff, 0x335522, 1.2));

  // blade: 5 segments
  const SEG = 5, pos = [], idx = [];
  for (let i = 0; i <= SEG; i++) { const v = i / SEG, w = 0.5 * (1 - v * 0.85); pos.push(-w, v, 0, w, v, 0); }
  for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const blade = new THREE.InstancedBufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  blade.setIndex(idx);
  const off = new Float32Array(N * 4);
  let s = 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt(rnd()) * 60, a = rnd() * Math.PI * 2;
    off[i * 4] = Math.cos(a) * r; off[i * 4 + 1] = Math.sin(a) * r; off[i * 4 + 2] = rnd() * 6.28; off[i * 4 + 3] = 0.3 + rnd() * 0.5;
  }
  blade.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  blade.instanceCount = N;
  const grassMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `attribute vec4 aOff; uniform float uTime; varying float vH; varying vec3 vN;
      void main(){ vec3 p = position; float h = aOff.w; p.x *= 0.03; p.y *= h; float c = cos(aOff.z), s = sin(aOff.z);
        p.xz = mat2(c,-s,s,c) * p.xz; float bend = p.y*p.y*0.4*(0.6+0.4*sin(uTime*2.0+aOff.x*0.3)); p.x += bend;
        vec3 wp = vec3(aOff.x, 0.0, aOff.y) + p; vH = position.y; vN = normalize(vec3(s, 0.4, c));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0); }`,
    fragmentShader: `varying float vH; varying vec3 vN; void main(){ float l = 0.4 + 0.6*max(dot(vN, normalize(vec3(0.6,0.8,-0.4))),0.0); gl_FragColor = vec4(mix(vec3(0.05,0.15,0.02), vec3(0.4,0.75,0.15), vH)*l*2.0, 1.0); }`,
  });
  const grass = new THREE.Mesh(blade, grassMat);
  grass.frustumCulled = false;
  scene.add(grass);

  return {
    scene, camera, info: { blades: N },
    sceneTiles: +(q.get('tiles') || 1),
    update(t) {
      grassMat.uniforms.uTime.value = t;
      camera.position.set(Math.sin(t * 0.2) * 5, 0.6, 8 - t * 1.5);
      camera.lookAt(0, 0.3, -20 - t * 1.5);
    },
    post() { return { focus: 6, cocK: +(q.get('dof') || 0), paint: +(q.get('paint') ?? 1) }; },
  };
}
