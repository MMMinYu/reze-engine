use crate::math::Vec3;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Clone, Serialize, Deserialize)]
pub struct Texture {
    #[wasm_bindgen(getter_with_clone)]
    pub path: String,
    #[wasm_bindgen(getter_with_clone)]
    pub name: String,
}

#[wasm_bindgen]
#[derive(Clone, Serialize, Deserialize)]
pub struct Material {
    #[wasm_bindgen(getter_with_clone)]
    pub name: String,
    #[wasm_bindgen(getter_with_clone)]
    pub diffuse: Vec<f32>,
    #[wasm_bindgen(getter_with_clone)]
    pub specular: Vec<f32>,
    #[wasm_bindgen(getter_with_clone)]
    pub ambient: Vec<f32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Bone {
    pub name: String,
    pub parent_index: i32,
    pub bind_translation: Vec3,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Morph {
    pub name: String,
    pub morph_type: u8,
    pub vertex_offsets: Vec<(usize, [f32; 3])>, // (vertex_index, [x, y, z])
    pub group_references: Vec<(usize, f32)>,    // (morph_index, ratio)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Skinning {
    pub joints: Vec<u32>,
    pub weights: Vec<f32>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum RigidbodyShape {
    Sphere = 0,
    Box = 1,
    Capsule = 2,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum RigidbodyType {
    Static = 0,
    Dynamic = 1,
    Kinematic = 2,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Rigidbody {
    pub name: String,
    pub english_name: String,
    pub bone_index: i32,
    pub group: u8,
    pub collision_mask: u16,
    pub shape: RigidbodyShape,
    pub size: Vec3,
    pub shape_position: Vec3,
    pub shape_rotation: Vec3,
    pub mass: f32,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub restitution: f32,
    pub friction: f32,
    pub type_: RigidbodyType,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Joint {
    pub name: String,
    pub english_name: String,
    pub type_: u8,
    pub rigidbody_index_a: i32,
    pub rigidbody_index_b: i32,
    pub position: Vec3,
    pub rotation: Vec3,
    pub position_min: Vec3,
    pub position_max: Vec3,
    pub rotation_min: Vec3,
    pub rotation_max: Vec3,
    pub spring_position: Vec3,
    pub spring_rotation: Vec3,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ModelData {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub textures: Vec<Texture>,
    pub materials: Vec<Material>,
    pub bones: Vec<Bone>,
    pub skinning: Skinning,
    pub morphs: Vec<Morph>,
    pub rigidbodies: Vec<Rigidbody>,
    pub joints: Vec<Joint>,
}

pub struct Model {
    data: ModelData,
}

impl Model {
    pub fn new(data: ModelData) -> Self {
        Self { data }
    }

    pub fn get_vertices(&self) -> Vec<f32> {
        self.data.vertices.clone()
    }

    pub fn get_indices(&self) -> Vec<u32> {
        self.data.indices.clone()
    }

    pub fn get_textures(&self) -> Vec<Texture> {
        self.data.textures.clone()
    }

    pub fn get_materials(&self) -> Vec<Material> {
        self.data.materials.clone()
    }
}
