use reze_mmd::PmxLoader;
use std::fs;

fn main() {
    // Read PMX file
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <pmx_file>", args[0]);
        std::process::exit(1);
    }

    let file_path = &args[1];
    println!("Loading PMX file: {}", file_path);

    let buffer = match fs::read(file_path) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("Failed to read file: {}", e);
            std::process::exit(1);
        }
    };

    // Parse PMX
    let model_data = match PmxLoader::load(buffer) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("Failed to parse PMX: {}", e);
            std::process::exit(1);
        }
    };

    // Log statistics
    let vertex_count = model_data.vertices.len() / 8; // 8 floats per vertex (pos3 + normal3 + uv2)
    let index_count = model_data.indices.len();
    let bone_count = model_data.bones.len();
    let material_count = model_data.materials.len();
    let morph_count = model_data.morphs.len();
    let rigidbody_count = model_data.rigidbodies.len();
    let joint_count = model_data.joints.len();
    let skinning_joint_count = model_data.skinning.joints.len();
    let texture_count = model_data.textures.len();

    println!("Loaded PMX successfully!");
    println!(
        "  Vertices: {} ({} joint indices, 4 per vertex)",
        vertex_count, skinning_joint_count
    );
    println!("  Indices: {}", index_count);
    println!("  Bones: {}", bone_count);
    println!("  Materials: {}", material_count);
    println!("  Textures: {}", texture_count);
    println!("  Morphs: {}", morph_count);
    println!("  Rigidbodies: {}", rigidbody_count);
    println!("  Physics Joints: {}", joint_count);
}
