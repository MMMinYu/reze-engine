import { Vec3, Mat4 } from "../math"

export enum RigidbodyShape {
  Sphere = 0,
  Box = 1,
  Capsule = 2,
}

export enum RigidbodyType {
  Static = 0,
  Dynamic = 1,
  Kinematic = 2,
}

export interface Rigidbody {
  name: string
  englishName: string
  boneIndex: number
  group: number
  collisionMask: number
  shape: RigidbodyShape
  size: Vec3
  shapePosition: Vec3 // Bind pose world space position from PMX
  shapeRotation: Vec3 // Bind pose world space rotation (Euler angles) from PMX
  mass: number
  linearDamping: number
  angularDamping: number
  restitution: number
  friction: number
  type: RigidbodyType
  bodyOffsetMatrixInverse: Mat4 // Inverse of body offset matrix, used to sync rigidbody to bone
  bodyOffsetMatrix?: Mat4 // Cached non-inverse for performance (computed once during initialization)
}

export interface Joint {
  name: string
  englishName: string
  type: number
  rigidbodyIndexA: number
  rigidbodyIndexB: number
  position: Vec3
  rotation: Vec3 // Euler angles in radians
  positionMin: Vec3
  positionMax: Vec3
  rotationMin: Vec3 // Euler angles in radians
  rotationMax: Vec3 // Euler angles in radians
  springPosition: Vec3
  springRotation: Vec3 // Spring stiffness values
}

// Reserved for future engine-level overrides (gravity scale, solver iter count,
// etc.). The Bullet 2.75 anchor convention removed the only previous field
// (constraintSolverKeywords), so the shape is currently empty.
export type PhysicsOptions = Record<string, never>
