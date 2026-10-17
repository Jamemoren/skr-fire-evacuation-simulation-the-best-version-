import * as THREE from "three";

export const STUDENT_INSTANCE_CAPACITY = 2200;

/** xyz: stable gait phase, target stride, complexion; w: hair shade. */
export function attachStudentMotion(geometry: THREE.BufferGeometry) {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(STUDENT_INSTANCE_CAPACITY * 4), 4);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("studentMotion", attribute);
  for (const name of ["studentTransition", "studentBlend"]) {
    const buffer = new THREE.InstancedBufferAttribute(new Float32Array(STUDENT_INSTANCE_CAPACITY * 4), 4);
    buffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, buffer);
  }
  return attribute;
}

export function studentTransitionBuffers(geometry: THREE.BufferGeometry) {
  return {
    transition: geometry.getAttribute("studentTransition") as THREE.InstancedBufferAttribute,
    blend: geometry.getAttribute("studentBlend") as THREE.InstancedBufferAttribute,
  };
}

export function uploadStudentMotion(attribute: THREE.InstancedBufferAttribute, count: number) {
  attribute.clearUpdateRanges();
  if (!count) return 0;
  attribute.addUpdateRange(0, count * 4);
  attribute.needsUpdate = true;
  return count * 4 * Float32Array.BYTES_PER_ELEMENT;
}

/** Analytic hip/shoulder/knee animation runs on the GPU, with no per-student skeletons. */
export function createStudentMaterial() {
  const time = { value: 0 };
  const detail = { value: 1 };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.studentTime = time;
    shader.uniforms.studentDetail = detail;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `
      #include <common>
      attribute vec4 studentRig;
      attribute float studentFeature;
      attribute vec4 studentMotion;
      attribute vec4 studentTransition;
      attribute vec4 studentBlend;
      uniform float studentTime;
      uniform float studentDetail;
      float poseProgress, poseEase, poseStride, poseWave, poseIdle;
      float poseArm, poseHead, poseSway, poseLift, poseBreath;
      vec3 studentRotateX(vec3 p, float a) {
        float c = cos(a), s = sin(a);
        return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
      }
      vec3 studentRotateY(vec3 p, float a) {
        float c = cos(a), s = sin(a);
        return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
      }
      vec3 studentRotateZ(vec3 p, float a) {
        float c = cos(a), s = sin(a);
        return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
      }
      void studentPreparePose() {
        poseProgress = clamp((studentTime - studentTransition.w) / max(0.001, studentBlend.z), 0.0, 1.0);
        poseEase = poseProgress * poseProgress * (3.0 - 2.0 * poseProgress);
        poseStride = mix(studentBlend.y, studentMotion.y, poseEase);
        float phase = studentTime * 8.2 + studentMotion.x;
        poseWave = sin(phase) * sign(studentRig.w);
        poseIdle = (1.0 - min(1.0, poseStride)) * studentBlend.w * studentDetail;
        poseArm = 0.0; poseHead = 0.0; poseBreath = 0.0;
        poseSway = sin(phase) * 0.012 * poseStride;
        poseLift = (1.0 - cos(phase * 2.0)) * 0.005 * poseStride;
        if (poseIdle > 0.001) {
          poseArm = sin(studentTime * 1.35 + studentMotion.x) * 0.025 * sign(studentRig.w) * poseIdle;
          if (position.y > 1.28) poseHead = sin(studentTime * 0.63 + studentMotion.x * 0.21) * 0.045 * poseIdle * smoothstep(1.28, 1.32, position.y);
          poseSway += sin(studentTime * 0.8 + studentMotion.x) * 0.004 * poseIdle;
          poseBreath = sin(studentTime * 1.7 + studentMotion.x) * 0.009 * poseIdle;
        }
      }
      vec3 studentPose(vec3 p, bool isNormal) {
        if (studentBlend.w < 0.5) return p;
        float kind = abs(studentRig.w);
        if (kind > 0.5) {
          float angle = poseWave * poseStride * (kind < 1.5 ? -0.40 : 0.30);
          if (kind < 1.5) angle += poseArm;
          vec3 pivot = studentRig.xyz;
          if (kind > 2.5) {
            float knee = max(0.0, -poseWave) * poseStride * 0.48;
            p = studentRotateX(p - (isNormal ? vec3(0.0) : pivot), knee) + (isNormal ? vec3(0.0) : pivot);
            pivot.y += 0.255;
          }
          p = studentRotateX(p - (isNormal ? vec3(0.0) : pivot), angle) + (isNormal ? vec3(0.0) : pivot);
        }
        if (!isNormal) {
          // Chest breathing at rest, with feet and head height unchanged.
          float chest = smoothstep(0.85, 1.02, p.y) * (1.0 - smoothstep(1.20, 1.30, p.y));
          p.xz *= 1.0 + chest * poseBreath;
        }
        vec3 neck = isNormal ? vec3(0.0) : vec3(0.0, 1.29, 0.0);
        if (abs(poseHead) > 0.00001) p = studentRotateY(p - neck, poseHead) + neck;
        vec3 waist = isNormal ? vec3(0.0) : vec3(0.0, 0.86, 0.0);
        if (abs(poseSway) > 0.00001) p = studentRotateZ(p - waist, poseSway) + waist;
        if (!isNormal) p.y += poseLift;
        float turn = studentBlend.x * (1.0 - poseEase);
        if (abs(turn) > 0.00001) p = studentRotateY(p, turn);
        if (!isNormal) p += studentTransition.xyz * (1.0 - poseProgress);
        return p;
      }
    `).replace("#include <beginnormal_vertex>", `
      #include <beginnormal_vertex>
      studentPreparePose();
      objectNormal = studentPose(objectNormal, true);
    `).replace("#include <begin_vertex>", `
      #include <begin_vertex>
      transformed = studentPose(transformed, false);
    `).replace("#include <color_vertex>", `
      #include <color_vertex>
      #ifdef USE_COLOR
        if (studentFeature > 0.5 && studentFeature < 1.5) {
          vColor *= mix(vec3(0.76, 0.68, 0.61), vec3(1.07, 1.02, 0.98), studentMotion.z);
        } else if (studentFeature > 1.5) {
          vColor *= mix(vec3(0.48, 0.49, 0.52), vec3(1.12, 0.92, 0.77), studentMotion.w);
        }
      #endif
    `);
  };
  material.customProgramCacheKey = () => "student-uniform-gait-v2-smooth";
  return { material, time, detail };
}
