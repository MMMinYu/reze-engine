// 6DOF spring + contact constraint solver. Sequential-impulse projected
// Gauss-Seidel: per axis, target a relative velocity (limit correction +
// spring), apply the impulse needed to reach it. Friction is two Coulomb
// rows per contact, normal is push-only.

import { Mat4 } from "../math"
import type { RigidBodyStore } from "./body"
import type { SixDofSpringConstraint } from "./constraint"
import { STOP_ERP } from "./constraint"
import type { Contact, ContactPool } from "./contact"

const BOUNCE_THRESHOLD = 2.0

// Module-level scratch (no per-iter allocations).
const _TA = new Float32Array(16)
const _TB = new Float32Array(16)
const _bodyMatA = new Float32Array(16)
const _bodyMatB = new Float32Array(16)
const _linAxes = new Float32Array(9)   // 3 linear axes × xyz
const _angAxes = new Float32Array(9)   // 3 angular axes × xyz
const _linDiff = new Float32Array(3)
const _angDiff = new Float32Array(3)
const _rA = new Float32Array(3)
const _rB = new Float32Array(3)

export function solveConstraints(
  store: RigidBodyStore,
  constraints: SixDofSpringConstraint[],
  contacts: ContactPool,
  dt: number,
  iterations: number,
): void {
  if (dt <= 0) return
  if (constraints.length === 0 && contacts.count === 0) return

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
      Mat4.multiplyArrays(_bodyMatA, 0, con.frameA, 0, _TA, 0)
      Mat4.multiplyArrays(_bodyMatB, 0, con.frameB, 0, _TB, 0)

      // Mass-weighted shared anchor: kinematic partner gets weight 1 so
      // the anchor sits exactly on it; two dynamic bodies blend by inverse
      // mass. Lever arms are measured from each CG to that shared anchor.
      const ai = a * 3
      const bi = b * 3
      const weightA = imB === 0 ? 1 : imA / (imA + imB)
      const weightB = 1 - weightA
      const anchorX = _TA[12] * weightA + _TB[12] * weightB
      const anchorY = _TA[13] * weightA + _TB[13] * weightB
      const anchorZ = _TA[14] * weightA + _TB[14] * weightB
      _rA[0] = anchorX - pos[ai + 0]
      _rA[1] = anchorY - pos[ai + 1]
      _rA[2] = anchorZ - pos[ai + 2]
      _rB[0] = anchorX - pos[bi + 0]
      _rB[1] = anchorY - pos[bi + 1]
      _rB[2] = anchorZ - pos[bi + 2]

      // Linear part: linearDiff = TA.basis^T · (TB.origin − TA.origin),
      // axes = TA's columns 0/1/2 in world space.
      const dxw = _TB[12] - _TA[12]
      const dyw = _TB[13] - _TA[13]
      const dzw = _TB[14] - _TA[14]
      _linDiff[0] = _TA[0] * dxw + _TA[1] * dyw + _TA[2] * dzw
      _linDiff[1] = _TA[4] * dxw + _TA[5] * dyw + _TA[6] * dzw
      _linDiff[2] = _TA[8] * dxw + _TA[9] * dyw + _TA[10] * dzw

      _linAxes[0] = _TA[0]; _linAxes[1] = _TA[1]; _linAxes[2] = _TA[2]
      _linAxes[3] = _TA[4]; _linAxes[4] = _TA[5]; _linAxes[5] = _TA[6]
      _linAxes[6] = _TA[8]; _linAxes[7] = _TA[9]; _linAxes[8] = _TA[10]

      for (let i = 0; i < 3; i++) {
        const lo = con.linearMin[i]
        const hi = con.linearMax[i]
        const curr = _linDiff[i]
        const off = i * 3
        const axx = _linAxes[off + 0]
        const axy = _linAxes[off + 1]
        const axz = _linAxes[off + 2]

        // (rA × axis), (rB × axis): angular components of the linear Jacobian.
        const cAx = _rA[1] * axz - _rA[2] * axy
        const cAy = _rA[2] * axx - _rA[0] * axz
        const cAz = _rA[0] * axy - _rA[1] * axx
        const cBx = _rB[1] * axz - _rB[2] * axy
        const cBy = _rB[2] * axx - _rB[0] * axz
        const cBz = _rB[0] * axy - _rB[1] * axx
        const cA2 = cAx * cAx + cAy * cAy + cAz * cAz
        const cB2 = cBx * cBx + cBy * cBy + cBz * cBz
        const denom = imA + imB + cA2 * iiA + cB2 * iiB
        if (denom <= 0) continue
        const jacInv = 1 / denom

        // v_pivot = v_CG + ω × r.
        const vAx = lv[ai + 0] + av[ai + 1] * _rA[2] - av[ai + 2] * _rA[1]
        const vAy = lv[ai + 1] + av[ai + 2] * _rA[0] - av[ai + 0] * _rA[2]
        const vAz = lv[ai + 2] + av[ai + 0] * _rA[1] - av[ai + 1] * _rA[0]
        const vBx = lv[bi + 0] + av[bi + 1] * _rB[2] - av[bi + 2] * _rB[1]
        const vBy = lv[bi + 1] + av[bi + 2] * _rB[0] - av[bi + 0] * _rB[2]
        const vBz = lv[bi + 2] + av[bi + 0] * _rB[1] - av[bi + 1] * _rB[0]
        const relVel = (vBx - vAx) * axx + (vBy - vAy) * axy + (vBz - vAz) * axz

        let targetVel = 0
        let active = false

        if (lo <= hi) {
          let err = 0
          if (curr < lo) err = curr - lo
          else if (curr > hi) err = curr - hi
          if (err !== 0) {
            targetVel = -err * STOP_ERP * invDt
            active = true
          }
        }
        if (con.springEnabled[i]) {
          targetVel += -con.springStiffness[i] * (curr - con.equilibriumPoint[i]) * dt
          active = true
        }

        if (active) {
          const j = (targetVel - relVel) * jacInv
          if (imA > 0) {
            lv[ai + 0] -= j * imA * axx
            lv[ai + 1] -= j * imA * axy
            lv[ai + 2] -= j * imA * axz
            av[ai + 0] -= j * iiA * cAx
            av[ai + 1] -= j * iiA * cAy
            av[ai + 2] -= j * iiA * cAz
          }
          if (imB > 0) {
            lv[bi + 0] += j * imB * axx
            lv[bi + 1] += j * imB * axy
            lv[bi + 2] += j * imB * axz
            av[bi + 0] += j * iiB * cBx
            av[bi + 1] += j * iiB * cBy
            av[bi + 2] += j * iiB * cBz
          }
        }
      }

      // Angular part: relative rotation TA^T·TB → Euler XYZ; axes from
      // TA.col2 × TB.col0 (as Bullet's calculatedAxis derivation).
      const r00 = _TA[0]*_TB[0] + _TA[1]*_TB[1] + _TA[2]*_TB[2]
      const r01 = _TA[0]*_TB[4] + _TA[1]*_TB[5] + _TA[2]*_TB[6]
      const r10 = _TA[4]*_TB[0] + _TA[5]*_TB[1] + _TA[6]*_TB[2]
      const r11 = _TA[4]*_TB[4] + _TA[5]*_TB[5] + _TA[6]*_TB[6]
      const r20 = _TA[8]*_TB[0] + _TA[9]*_TB[1] + _TA[10]*_TB[2]
      const r21 = _TA[8]*_TB[4] + _TA[9]*_TB[5] + _TA[10]*_TB[6]
      const r22 = _TA[8]*_TB[8] + _TA[9]*_TB[9] + _TA[10]*_TB[10]
      matrixToEulerXYZ(r00, r01, r10, r11, r20, r21, r22, _angDiff)

      const a2x = _TA[8],  a2y = _TA[9],  a2z = _TA[10]
      const b0x = _TB[0],  b0y = _TB[1],  b0z = _TB[2]
      // ax[1] = a2 × b0; ax[0] = ax[1] × a2; ax[2] = b0 × ax[1].
      let yx = a2y * b0z - a2z * b0y
      let yy = a2z * b0x - a2x * b0z
      let yz = a2x * b0y - a2y * b0x
      let l = Math.hypot(yx, yy, yz)
      if (l > 1e-8) { const inv = 1/l; yx*=inv; yy*=inv; yz*=inv }
      _angAxes[3] = yx; _angAxes[4] = yy; _angAxes[5] = yz
      let xx = yy * a2z - yz * a2y
      let xy = yz * a2x - yx * a2z
      let xz = yx * a2y - yy * a2x
      l = Math.hypot(xx, xy, xz)
      if (l > 1e-8) { const inv = 1/l; xx*=inv; xy*=inv; xz*=inv }
      _angAxes[0] = xx; _angAxes[1] = xy; _angAxes[2] = xz
      let zx = b0y * yz - b0z * yy
      let zy = b0z * yx - b0x * yz
      let zz = b0x * yy - b0y * yx
      l = Math.hypot(zx, zy, zz)
      if (l > 1e-8) { const inv = 1/l; zx*=inv; zy*=inv; zz*=inv }
      _angAxes[6] = zx; _angAxes[7] = zy; _angAxes[8] = zz

      const angDenom = iiA + iiB
      if (angDenom > 0) {
        const angJacInv = 1 / angDenom

        for (let i = 0; i < 3; i++) {
          const idx = i + 3
          const lo = con.angularMin[i]
          const hi = con.angularMax[i]
          const curr = _angDiff[i]
          const off = i * 3
          const axx = _angAxes[off + 0]
          const axy = _angAxes[off + 1]
          const axz = _angAxes[off + 2]

          const relAv =
            (av[bi + 0] - av[ai + 0]) * axx +
            (av[bi + 1] - av[ai + 1]) * axy +
            (av[bi + 2] - av[ai + 2]) * axz

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
            targetVel += con.springStiffness[idx] * (curr - con.equilibriumPoint[idx]) * dt
            active = true
          }

          if (active) {
            const j = (targetVel - relAv) * angJacInv
            if (iiA > 0) {
              av[ai + 0] -= j * iiA * axx
              av[ai + 1] -= j * iiA * axy
              av[ai + 2] -= j * iiA * axz
            }
            if (iiB > 0) {
              av[bi + 0] += j * iiB * axx
              av[bi + 1] += j * iiB * axy
              av[bi + 2] += j * iiB * axz
            }
          }
        }
      }
    }

    for (let ci = 0; ci < contacts.count; ci++) {
      solveContactRow(contacts.get(ci), lv, av, invMass, invInertia)
    }
  }
}

// Per-contact: one push-only normal row + two Coulomb friction rows
// (impulse bound = ±μ·appliedNormalImpulse).
function solveContactRow(
  c: Contact,
  lv: Float32Array,
  av: Float32Array,
  invMass: Float32Array,
  invInertia: Float32Array,
): void {
  const ai = c.bodyA * 3, bi = c.bodyB * 3
  const imA = invMass[c.bodyA], imB = invMass[c.bodyB]
  const iiA = invInertia[c.bodyA], iiB = invInertia[c.bodyB]
  if (imA === 0 && imB === 0) return
  const rAx = c.rAx, rAy = c.rAy, rAz = c.rAz
  const rBx = c.rBx, rBy = c.rBy, rBz = c.rBz
  const nx = c.nx, ny = c.ny, nz = c.nz

  const vAx = lv[ai + 0] + av[ai + 1] * rAz - av[ai + 2] * rAy
  const vAy = lv[ai + 1] + av[ai + 2] * rAx - av[ai + 0] * rAz
  const vAz = lv[ai + 2] + av[ai + 0] * rAy - av[ai + 1] * rAx
  const vBx = lv[bi + 0] + av[bi + 1] * rBz - av[bi + 2] * rBy
  const vBy = lv[bi + 1] + av[bi + 2] * rBx - av[bi + 0] * rBz
  const vBz = lv[bi + 2] + av[bi + 0] * rBy - av[bi + 1] * rBx
  const dvX = vBx - vAx
  const dvY = vBy - vAy
  const dvZ = vBz - vAz

  // Normal row.
  const cAxN = rAy * nz - rAz * ny
  const cAyN = rAz * nx - rAx * nz
  const cAzN = rAx * ny - rAy * nx
  const cBxN = rBy * nz - rBz * ny
  const cByN = rBz * nx - rBx * nz
  const cBzN = rBx * ny - rBy * nx
  const denomN = imA + imB +
    (cAxN * cAxN + cAyN * cAyN + cAzN * cAzN) * iiA +
    (cBxN * cBxN + cByN * cByN + cBzN * cBzN) * iiB
  if (denomN <= 0) return
  const jacInvN = 1 / denomN

  const relVelN = dvX * nx + dvY * ny + dvZ * nz
  // Position correction is handled directly in world.ts (split impulse).
  // Velocity row only removes approach + applies restitution above bounce.
  let bounce = 0
  if (c.restitution > 0 && relVelN < -BOUNCE_THRESHOLD) {
    bounce = -c.restitution * relVelN
  }
  let dImpN = (bounce - relVelN) * jacInvN
  const oldN = c.appliedNormalImpulse
  let newN = oldN + dImpN
  if (newN < 0) { newN = 0; dImpN = -oldN }
  c.appliedNormalImpulse = newN

  if (dImpN !== 0) {
    if (imA > 0) {
      lv[ai + 0] -= dImpN * imA * nx
      lv[ai + 1] -= dImpN * imA * ny
      lv[ai + 2] -= dImpN * imA * nz
      av[ai + 0] -= dImpN * iiA * cAxN
      av[ai + 1] -= dImpN * iiA * cAyN
      av[ai + 2] -= dImpN * iiA * cAzN
    }
    if (imB > 0) {
      lv[bi + 0] += dImpN * imB * nx
      lv[bi + 1] += dImpN * imB * ny
      lv[bi + 2] += dImpN * imB * nz
      av[bi + 0] += dImpN * iiB * cBxN
      av[bi + 1] += dImpN * iiB * cByN
      av[bi + 2] += dImpN * iiB * cBzN
    }
  }

  // Friction tangent basis. Pick the axis least aligned with n to avoid a
  // near-zero cross product.
  let t1x: number, t1y: number, t1z: number
  if (Math.abs(nx) < 0.7071) { t1x = 0; t1y = -nz; t1z = ny }
  else { t1x = nz; t1y = 0; t1z = -nx }
  const l = Math.hypot(t1x, t1y, t1z)
  if (l < 1e-8) return
  const tInv = 1 / l
  t1x *= tInv; t1y *= tInv; t1z *= tInv
  const t2x = ny * t1z - nz * t1y
  const t2y = nz * t1x - nx * t1z
  const t2z = nx * t1y - ny * t1x

  const muNormal = c.friction * c.appliedNormalImpulse

  applyFrictionRow(c, ai, bi, t1x, t1y, t1z,
    rAx, rAy, rAz, rBx, rBy, rBz, dvX, dvY, dvZ,
    imA, imB, iiA, iiB, lv, av, muNormal, 1)
  applyFrictionRow(c, ai, bi, t2x, t2y, t2z,
    rAx, rAy, rAz, rBx, rBy, rBz, dvX, dvY, dvZ,
    imA, imB, iiA, iiB, lv, av, muNormal, 2)
}

function applyFrictionRow(
  c: Contact,
  ai: number, bi: number,
  tx: number, ty: number, tz: number,
  rAx: number, rAy: number, rAz: number,
  rBx: number, rBy: number, rBz: number,
  dvX: number, dvY: number, dvZ: number,
  imA: number, imB: number, iiA: number, iiB: number,
  lv: Float32Array, av: Float32Array,
  muNormal: number,
  slot: 1 | 2,
): void {
  if (muNormal <= 0) return
  const cAx = rAy * tz - rAz * ty
  const cAy = rAz * tx - rAx * tz
  const cAz = rAx * ty - rAy * tx
  const cBx = rBy * tz - rBz * ty
  const cBy = rBz * tx - rBx * tz
  const cBz = rBx * ty - rBy * tx
  const denom = imA + imB +
    (cAx * cAx + cAy * cAy + cAz * cAz) * iiA +
    (cBx * cBx + cBy * cBy + cBz * cBz) * iiB
  if (denom <= 0) return
  const jacInv = 1 / denom

  const relVel = dvX * tx + dvY * ty + dvZ * tz
  let dImp = -relVel * jacInv
  const old = slot === 1 ? c.appliedFrictionImpulse1 : c.appliedFrictionImpulse2
  let next = old + dImp
  if (next < -muNormal) { next = -muNormal; dImp = next - old }
  else if (next > muNormal) { next = muNormal; dImp = next - old }
  if (slot === 1) c.appliedFrictionImpulse1 = next
  else c.appliedFrictionImpulse2 = next

  if (dImp === 0) return
  if (imA > 0) {
    lv[ai + 0] -= dImp * imA * tx
    lv[ai + 1] -= dImp * imA * ty
    lv[ai + 2] -= dImp * imA * tz
    av[ai + 0] -= dImp * iiA * cAx
    av[ai + 1] -= dImp * iiA * cAy
    av[ai + 2] -= dImp * iiA * cAz
  }
  if (imB > 0) {
    lv[bi + 0] += dImp * imB * tx
    lv[bi + 1] += dImp * imB * ty
    lv[bi + 2] += dImp * imB * tz
    av[bi + 0] += dImp * iiB * cBx
    av[bi + 1] += dImp * iiB * cBy
    av[bi + 2] += dImp * iiB * cBz
  }
}

function buildBodyMat(store: RigidBodyStore, i: number, out: Float32Array): void {
  const i3 = i * 3, i4 = i * 4
  Mat4.fromPositionRotationInto(
    store.positions[i3 + 0], store.positions[i3 + 1], store.positions[i3 + 2],
    store.orientations[i4 + 0], store.orientations[i4 + 1], store.orientations[i4 + 2], store.orientations[i4 + 3],
    out,
  )
}

// Euler XYZ from a 3×3 rotation matrix (row-major elements).
function matrixToEulerXYZ(
  r00: number, r01: number,
  r10: number, r11: number,
  r20: number, r21: number, r22: number,
  out: Float32Array,
): void {
  if (r20 < 1) {
    if (r20 > -1) {
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
