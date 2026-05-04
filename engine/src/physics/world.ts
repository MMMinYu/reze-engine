import { Vec3 } from "../math"
import type { RigidBodyStore } from "./body"
import { RigidbodyType } from "./types"
import type { SixDofSpringConstraint } from "./constraint"
import { solveConstraints } from "./solver"

// World owns the simulator. Steps in Bullet's predict → solve → integrate
// order so constraint impulses take effect on the same frame they're computed:
//
//   1. Predict: gravity + damping update velocities (no position change).
//   2. Solve constraints: SI-style impulse correction adjusts velocities.
//   3. Integrate: pos += vel · dt; orientation += ½(ω · q) · dt, normalized.
//
// Damping matches Bullet 2.x: v *= clamp(1 − damping · dt, 0, 1). Static and
// kinematic bodies are skipped during predict/integrate; RezePhysics syncs
// those from bones around the step. Constraint solve runs on all bodies —
// kinematic ones have invMass = 0 and act as anchors.
export class World {
  readonly gravity: Vec3
  // Bullet defaults to 10 SI iterations; matching keeps tuning consistent.
  solverIterations = 10

  constructor(gravity: Vec3) {
    this.gravity = new Vec3(gravity.x, gravity.y, gravity.z)
  }

  setGravity(g: Vec3): void {
    this.gravity.x = g.x
    this.gravity.y = g.y
    this.gravity.z = g.z
  }

  step(store: RigidBodyStore, constraints: SixDofSpringConstraint[], dt: number): void {
    if (dt <= 0) return

    const N = store.count
    const types = store.type
    const lv = store.linearVelocities
    const av = store.angularVelocities
    const pos = store.positions
    const ori = store.orientations
    const ldamp = store.linearDamping
    const adamp = store.angularDamping
    const invMass = store.invMass

    const gx = this.gravity.x
    const gy = this.gravity.y
    const gz = this.gravity.z

    // 1. Predict: gravity + damping (velocities only, no position update).
    // Damping form matches btRigidBody::applyDamping exactly:
    //   vel *= (1 − damping)^dt
    // The linear `1 − damping·dt` approximation diverges at high PMX damping
    // values (e.g. 0.99) and changes how quickly motion bleeds out, so we
    // mirror Bullet's pow form for parameter fidelity.
    for (let i = 0; i < N; i++) {
      if (types[i] !== RigidbodyType.Dynamic || invMass[i] <= 0) continue
      const i3 = i * 3
      lv[i3 + 0] += gx * dt
      lv[i3 + 1] += gy * dt
      lv[i3 + 2] += gz * dt
      const ld = Math.pow(Math.max(0, 1 - ldamp[i]), dt)
      const ad = Math.pow(Math.max(0, 1 - adamp[i]), dt)
      lv[i3 + 0] *= ld; lv[i3 + 1] *= ld; lv[i3 + 2] *= ld
      av[i3 + 0] *= ad; av[i3 + 1] *= ad; av[i3 + 2] *= ad
    }

    // 2. Solve constraints: pulls bodies back into their joint envelopes,
    //    applies spring forces. Velocity-only correction so it composes with
    //    the integration step below.
    if (constraints.length > 0) {
      solveConstraints(store, constraints, dt, this.solverIterations)
    }

    // 3. Integrate transforms.
    for (let i = 0; i < N; i++) {
      if (types[i] !== RigidbodyType.Dynamic || invMass[i] <= 0) continue
      const i3 = i * 3
      const i4 = i * 4

      pos[i3 + 0] += lv[i3 + 0] * dt
      pos[i3 + 1] += lv[i3 + 1] * dt
      pos[i3 + 2] += lv[i3 + 2] * dt

      const wx = av[i3 + 0]
      const wy = av[i3 + 1]
      const wz = av[i3 + 2]
      if (wx !== 0 || wy !== 0 || wz !== 0) {
        const qx = ori[i4 + 0]
        const qy = ori[i4 + 1]
        const qz = ori[i4 + 2]
        const qw = ori[i4 + 3]

        const dx = qw * wx + wy * qz - wz * qy
        const dy = qw * wy + wz * qx - wx * qz
        const dz = qw * wz + wx * qy - wy * qx
        const dw = -(wx * qx + wy * qy + wz * qz)

        const half = 0.5 * dt
        const nx = qx + dx * half
        const ny = qy + dy * half
        const nz = qz + dz * half
        const nw = qw + dw * half

        const len2 = nx * nx + ny * ny + nz * nz + nw * nw
        if (len2 > 0) {
          const inv = 1 / Math.sqrt(len2)
          ori[i4 + 0] = nx * inv
          ori[i4 + 1] = ny * inv
          ori[i4 + 2] = nz * inv
          ori[i4 + 3] = nw * inv
        }
      }
    }
  }
}

