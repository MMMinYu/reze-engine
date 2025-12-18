use crate::{Material, PmxLoader, Texture, model::Model};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmModel {
    model: Model,
}

#[wasm_bindgen]
impl WasmModel {
    #[wasm_bindgen(constructor)]
    pub fn new(buffer: Vec<u8>) -> Result<Self, String> {
        let model_data = PmxLoader::load(buffer)?;
        let model = Model::new(model_data);
        Ok(Self { model })
    }

    pub fn get_vertices(&self) -> Vec<f32> {
        self.model.get_vertices()
    }

    pub fn get_indices(&self) -> Vec<u32> {
        self.model.get_indices()
    }

    pub fn get_textures(&self) -> Vec<Texture> {
        self.model.get_textures()
    }

    pub fn get_materials(&self) -> Vec<Material> {
        self.model.get_materials()
    }
}
