// 6DOF spring constraint solver. Modeled after Bullet's btGeneric6DofConstraint
// SI loop, condensed but using proper offset-point Jacobians: the constraint
// pivot can sit anywhere on each body, so a linear impulse along the
// constraint axis becomes BOTH a linear push at the CG *and* a torque about
// the body's center of mass — the lever arm cross product. Without this,
// gravity acting on a hair tip's CG never produces angular velocity, so hair
// won't swing under gravity. Angular constraints stay torque-only (no offset).
//
// Per-axis math, matching Bullet exactly:
//   linearDiff[i]  = (TA.basis^T · (TB.origin − TA.origin))[i]
//   angularDiff    = matrixToEulerXYZ(TA.basis^T · TB.basis)
//   calculatedAxis: ax[1] = TA.col2 × TB.col0
//                   ax[0] = ax[1] × TA.col2
//                   ax[2] = TB.col0 × ax[1]
//
//   Lever arms:    rA = TA.origin − bodyA.position (CG)
//                  rB = TB.origin − bodyB.position
//   Linear J:      J_A = (axis, rA × axis);  J_B = (−axis, −rB × axis)
//   relVel @pivot: (vB + ωB × rB) − (vA + ωA × rA)  along axis
//   jacDiagABInv:  1 / (invMassA + invMassB
//                       + (rA×axis)² · invInertiaA
//                       + (rB×axis)² · invInertiaB)
//
// Spring per iteration follows Bullet's clipped motor:
//   maxMotorImpulse = |k·δ| / fps;  per-iter contribution ≤ maxMotorImpulse·dt
//   Total spring impulse over a step ≤ |k·δ|·dt — distributed across iters
//   below to keep proportions right under varying iteration counts.
//
// Angular sign convention: d(angDiff[i])/dt = −(ω_B − ω_A)·ax[i] (Bullet's
// matrixToEulerXYZ with our calculatedAxis derivation), so the angular
// `targetVel` and spring impulse use the opposite sign from linear.

import { Mat4 } from "../math"
import type { RigidBodyStore } from "./body"
import type { SixDofSpringConstraint } from "./constraint"
import { STOP_ERP } from "./constraint"

const _TA = new Float32Array(16)
const _TB = new Float32Array(16)
const _bodyMatA = new Float32Array(16)
const _bodyMatB = new Float32Array(16)

const _axisX = new Float32Array(3)
const _axisY = new Float32Array(3)
const _axisZ = new Float32Array(3)
const _angAxisX = new Float32Array(3)
const _angAxisY = new Float32Array(3)
const _angAxisZ = new Float32Array(3)
const _euler = new Float32Array(3)
const _rA = new Float32Array(3)
const _rB = new Float32Array(3)

export function solveConstraints(
  store: RigidBodyStore,
  constraints: SixDofSpringConstraint[],
  dt: number,
  iterations: number,
): void {
  if (dt <= 0 || constraints.length === 0) return

  const invDt = 1 / dt

  const lv = store.linearVelocities
  const av = store.angularVelocities
  const pos = store.positions
  const invMass = store.invMass
  const invInertia = store.invInertia

  for (let iter = 0; iter < iterations; iter++) {
    for (let c = 0; c < constraints.length; c++) {
      const con = constraints[c]
      const a = con.bodyA
      const b = con.bodyB
      const imA = invMass[a]
      const imB = invMass[b]
      const iiA = invInertia[a]
      const iiB = invInertia[b]
      if (imA === 0 && imB === 0) continue

      buildBodyMat(store, a, _bodyMatA)
      buildBodyMat(store, b, _bodyMatB)

      // TA = worldA × frameA;  TB = worldB × frameB
      Mat4.multiplyArrays(_bodyMatA, 0, con.frameA, 0, _TA, 0)
      Mat4.multiplyArrays(_bodyMatB, 0, con.frameB, 0, _TB, 0)

      // Lever arms: pivot location relative to each body's CG (world).
      const ai = a * 3
      const bi = b * 3
      _rA[0] = _TA[12] - pos[ai + 0]
      _rA[1] = _TA[13] - pos[ai + 1]
      _rA[2] = _TA[14] - pos[ai + 2]
      _rB[0] = _TB[12] - pos[bi + 0]
      _rB[1] = _TB[13] - pos[bi + 1]
      _rB[2] = _TB[14] - pos[bi + 2]

      // -- Linear part (offset-point) -------------------------------------
      const dxw = _TB[12] - _TA[12]
      const dyw = _TB[13] - _TA[13]
      const dzw = _TB[14] - _TA[14]
      const dl0 = _TA[0] * dxw + _TA[1] * dyw + _TA[2] * dzw
      const dl1 = _TA[4] * dxw + _TA[5] * dyw + _TA[6] * dzw
      const dl2 = _TA[8] * dxw + _TA[9] * dyw + _TA[10] * dzw
      const linearDiff = [dl0, dl1, dl2]

      _axisX[0] = _TA[0]; _axisX[1] = _TA[1]; _axisX[2] = _TA[2]
      _axisY[0] = _TA[4]; _axisY[1] = _TA[5]; _axisY[2] = _TA[6]
      _axisZ[0] = _TA[8]; _axisZ[1] = _TA[9]; _axisZ[2] = _TA[10]
      const linAxes = [_axisX, _axisY, _axisZ]

      for (let i = 0; i < 3; i++) {
        const lo = con.linearMin[i]
        const hi = con.linearMax[i]
        const curr = linearDiff[i]
        const ax = linAxes[i]

        // (rA × axis) and (rB × axis) — angular components of the linear
        // Jacobian. They give both the velocity-at-pivot calculation and the
        // angular impulse to apply when correcting along this axis.
        const cAx = _rA[1] * ax[2] - _rA[2] * ax[1]
        const cAy = _rA[2] * ax[0] - _rA[0] * ax[2]
        const cAz = _rA[0] * ax[1] - _rA[1] * ax[0]
        const cBx = _rB[1] * ax[2] - _rB[2] * ax[1]
        const cBy = _rB[2] * ax[0] - _rB[0] * ax[2]
        const cBz = _rB[0] * ax[1] - _rB[1] * ax[0]
        const cA2 = cAx * cAx + cAy * cAy + cAz * cAz
        const cB2 = cBx * cBx + cBy * cBy + cBz * cBz
        const denom = imA + imB + cA2 * iiA + cB2 * iiB
        if (denom <= 0) continue
        const jacInv = 1 / denom

        // Velocity at pivot points along axis: v_pivot = v_CG + ω × r.
        const vAaxX = lv[ai + 0] + av[ai + 1] * _rA[2] - av[ai + 2] * _rA[1]
        const vAaxY = lv[ai + 1] + av[ai + 2] * _rA[0] - av[ai + 0] * _rA[2]
        const vAaxZ = lv[ai + 2] + av[ai + 0] * _rA[1] - av[ai + 1] * _rA[0]
        const vBaxX = lv[bi + 0] + av[bi + 1] * _rB[2] - av[bi + 2] * _rB[1]
        const vBaxY = lv[bi + 1] + av[bi + 2] * _rB[0] - av[bi + 0] * _rB[2]
        const vBaxZ = lv[bi + 2] + av[bi + 0] * _rB[1] - av[bi + 1] * _rB[0]
        const relVel =
          (vBaxX - vAaxX) * ax[0] + (vBaxY - vAaxY) * ax[1] + (vBaxZ - vAaxZ) * ax[2]

        let targetVel = 0
        let active = false

        // Limit correction.
        if (lo <= hi) {
          let err = 0
          if (curr < lo) err = curr - lo
          else if (curr > hi) err = curr - hi
          if (err !== 0) {
            targetVel = -err * STOP_ERP * invDt
            active = true
          }
        }
        // Spring contribution: matches the relVel delta Bullet's clipped
        // motor produces per step. internalUpdateSprings sets
        // maxMotorImpulse = |k·δ|·dt, and the SI clamp pins the accumulated
        // impulse to that bound on iter 1 — so total relVel change per step
        // is ±k·δ·dt regardless of iteration count. We bake this directly
        // into the target velocity (single-iter convergence has the same
        // effect as 10 capped iterations).
        if (con.springEnabled[i]) {
          const k = con.springStiffness[i]
          const eq = con.equilibriumPoint[i]
          targetVel += -k * (curr - eq) * dt
          active = true
        }

        if (active) {
          const j = (targetVel - relVel) * jacInv
          // Apply +j·axis at TB.origin to body B; −j·axis at TA.origin to A.
          if (imA > 0) {
            lv[ai + 0] -= j * imA * ax[0]
            lv[ai + 1] -= j * imA * ax[1]
            lv[ai + 2] -= j * imA * ax[2]
            av[ai + 0] -= j * iiA * cAx
            av[ai + 1] -= j * iiA * cAy
            av[ai + 2] -= j * iiA * cAz
          }
          if (imB > 0) {
            lv[bi + 0] += j * imB * ax[0]
            lv[bi + 1] += j * imB * ax[1]
            lv[bi + 2] += j * imB * ax[2]
            av[bi + 0] += j * iiB * cBx
            av[bi + 1] += j * iiB * cBy
            av[bi + 2] += j * iiB * cBz
          }
        }
      }

      // -- Angular part ----------------------------------------------------
      // Refresh TA/TB after linear solve (lever-arm impulses changed velocities,
      // not positions yet — but cleaner to be consistent).
      const r00 = _TA[0]*_TB[0] + _TA[1]*_TB[1] + _TA[2]*_TB[2]
      const r01 = _TA[0]*_TB[4] + _TA[1]*_TB[5] + _TA[2]*_TB[6]
      const r02 = _TA[0]*_TB[8] + _TA[1]*_TB[9] + _TA[2]*_TB[10]
      const r10 = _TA[4]*_TB[0] + _TA[5]*_TB[1] + _TA[6]*_TB[2]
      const r11 = _TA[4]*_TB[4] + _TA[5]*_TB[5] + _TA[6]*_TB[6]
      const r12 = _TA[4]*_TB[8] + _TA[5]*_TB[9] + _TA[6]*_TB[10]
      const r20 = _TA[8]*_TB[0] + _TA[9]*_TB[1] + _TA[10]*_TB[2]
      const r21 = _TA[8]*_TB[4] + _TA[9]*_TB[5] + _TA[10]*_TB[6]
      const r22 = _TA[8]*_TB[8] + _TA[9]*_TB[9] + _TA[10]*_TB[10]
      matrixToEulerXYZ(r00, r01, r02, r10, r11, r12, r20, r21, r22, _euler)
      const angDiff = [_euler[0], _euler[1], _euler[2]]

      const a2x = _TA[8],  a2y = _TA[9],  a2z = _TA[10]
      const b0x = _TB[0],  b0y = _TB[1],  b0z = _TB[2]
      cross(a2x, a2y, a2z, b0x, b0y, b0z, _angAxisY); normalize3(_angAxisY)
      cross(_angAxisY[0], _angAxisY[1], _angAxisY[2], a2x, a2y, a2z, _angAxisX); normalize3(_angAxisX)
      cross(b0x, b0y, b0z, _angAxisY[0], _angAxisY[1], _angAxisY[2], _angAxisZ); normalize3(_angAxisZ)
      const angAxes = [_angAxisX, _angAxisY, _angAxisZ]

      const angDenom = iiA + iiB
      if (angDenom > 0) {
        const angJacInv = 1 / angDenom

        for (let i = 0; i < 3; i++) {
          const idx = i + 3
          const lo = con.angularMin[i]
          const hi = con.angularMax[i]
          const curr = angDiff[i]
          const ax = angAxes[i]

          const relAv =
            (av[bi + 0] - av[ai + 0]) * ax[0] +
            (av[bi + 1] - av[ai + 1]) * ax[1] +
            (av[bi + 2] - av[ai + 2]) * ax[2]

          // Sign flip vs linear: d(angDiff)/dt = −(ω_B − ω_A)·ax.
          let targetVel = 0
          let active = false

          if (lo <= hi) {
            let err = 0
            if (curr < lo) err = curr - lo
            else if (curr > hi) err = curr - hi
            if (err !== 0) {
              targetVel = err * STOP_ERP * invDt
              active = true
            }
          }
          if (con.springEnabled[idx]) {
            const k = con.springStiffness[idx]
            const eq = con.equilibriumPoint[idx]
            targetVel += k * (curr - eq) * dt
            active = true
          }

          if (active) {
            const j = (targetVel - relAv) * angJacInv
            if (iiA > 0) {
              av[ai + 0] -= j * iiA * ax[0]
              av[ai + 1] -= j * iiA * ax[1]
              av[ai + 2] -= j * iiA * ax[2]
            }
            if (iiB > 0) {
              av[bi + 0] += j * iiB * ax[0]
              av[bi + 1] += j * iiB * ax[1]
              av[bi + 2] += j * iiB * ax[2]
            }
          }
        }
      }
    }
  }
}

// --- helpers ----------------------------------------------------------------

function buildBodyMat(store: RigidBodyStore, i: number, out: Float32Array): void {
  const i3 = i * 3, i4 = i * 4
  Mat4.fromPositionRotationInto(
    store.positions[i3 + 0], store.positions[i3 + 1], store.positions[i3 + 2],
    store.orientations[i4 + 0], store.orientations[i4 + 1], store.orientations[i4 + 2], store.orientations[i4 + 3],
    out,
  )
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Float32Array): void {
  out[0] = ay * bz - az * by
  out[1] = az * bx - ax * bz
  out[2] = ax * by - ay * bx
}

function normalize3(v: Float32Array): void {
  const l = Math.hypot(v[0], v[1], v[2])
  if (l > 1e-8) { const inv = 1 / l; v[0] *= inv; v[1] *= inv; v[2] *= inv }
}

// MatrixToEulerXYZ from Bullet (btGeneric6DofConstraint.cpp). r_ij = mat[i][j].
// Bullet's btGetMatrixElem(mat, k) maps k%3 → row, k/3 → col, so the asin
// pivot is mat[2][0] (= r20), not mat[0][2].
function matrixToEulerXYZ(
  r00: number, r01: number, _r02: number,
  r10: number, r11: number, _r12: number,
  r20: number, r21: number, r22: number,
  out: Float32Array,
): void {
  const fi = r20
  if (fi < 1) {
    if (fi > -1) {
      out[0] = Math.atan2(-r21, r22)
      out[1] = Math.asin(r20)
      out[2] = Math.atan2(-r10, r00)
    } else {
      out[0] = -Math.atan2(r01, r11)
      out[1] = -Math.PI * 0.5
      out[2] = 0
    }
  } else {
    out[0] = Math.atan2(r01, r11)
    out[1] = Math.PI * 0.5
    out[2] = 0
  }
}
