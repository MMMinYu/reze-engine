use crate::math;
use crate::model::{
    Bone, Joint, Material, ModelData, Morph, Rigidbody, RigidbodyShape, RigidbodyType, Skinning,
    Texture,
};

#[allow(dead_code)]
pub struct PmxLoader;

impl PmxLoader {
    pub fn load(buffer: Vec<u8>) -> Result<ModelData, String> {
        let mut offset;
        let encoding;
        let additional_vec4_count;
        let vertex_index_size;
        let texture_index_size;
        let material_index_size;
        let bone_index_size;
        let morph_index_size;
        let rigid_body_index_size;
        let vertex_count;

        fn get_u8(buffer: &[u8], offset: &mut usize) -> Result<u8, String> {
            if *offset >= buffer.len() {
                return Err(format!(
                    "Offset {} exceeds buffer bounds {}",
                    *offset,
                    buffer.len()
                ));
            }
            let v = buffer[*offset];
            *offset += 1;
            Ok(v)
        }

        fn get_u16(buffer: &[u8], offset: &mut usize) -> Result<u16, String> {
            if *offset + 2 > buffer.len() {
                return Err(format!("Offset {} + 2 exceeds buffer bounds", *offset));
            }
            let v = u16::from_le_bytes([buffer[*offset], buffer[*offset + 1]]);
            *offset += 2;
            Ok(v)
        }

        fn get_i32(buffer: &[u8], offset: &mut usize) -> Result<i32, String> {
            if *offset + 4 > buffer.len() {
                return Err(format!(
                    "Offset {} + 4 exceeds buffer bounds {}",
                    *offset,
                    buffer.len()
                ));
            }
            let v = i32::from_le_bytes([
                buffer[*offset],
                buffer[*offset + 1],
                buffer[*offset + 2],
                buffer[*offset + 3],
            ]);
            *offset += 4;
            Ok(v)
        }

        fn get_f32(buffer: &[u8], offset: &mut usize) -> Result<f32, String> {
            if *offset + 4 > buffer.len() {
                return Err(format!("Offset {} + 4 exceeds buffer bounds", *offset));
            }
            let v = f32::from_le_bytes([
                buffer[*offset],
                buffer[*offset + 1],
                buffer[*offset + 2],
                buffer[*offset + 3],
            ]);
            *offset += 4;
            Ok(v)
        }

        fn get_text(buffer: &[u8], offset: &mut usize, encoding: u8) -> Result<String, String> {
            if *offset + 4 > buffer.len() {
                return Ok(String::new());
            }
            let len = get_i32(buffer, offset)?;
            if len <= 0 {
                return Ok(String::new());
            }
            let len = len as usize;
            if *offset + len > buffer.len() {
                *offset = buffer.len();
                return Ok(String::new());
            }

            let bytes = &buffer[*offset..*offset + len];
            *offset += len;

            let text = if encoding == 0 {
                let mut chars = Vec::new();
                for i in (0..bytes.len()).step_by(2) {
                    if i + 1 < bytes.len() {
                        let code = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
                        if let Some(ch) = char::from_u32(code as u32) {
                            chars.push(ch);
                        }
                    }
                }
                chars.into_iter().collect()
            } else {
                String::from_utf8_lossy(bytes).to_string()
            };

            Ok(text)
        }

        fn get_vertex_index(buffer: &[u8], offset: &mut usize, size: u8) -> Result<usize, String> {
            match size {
                1 => Ok(get_u8(buffer, offset)? as usize),
                2 => Ok(get_u16(buffer, offset)? as usize),
                4 => Ok(get_i32(buffer, offset)? as usize),
                _ => Err(format!("Invalid vertex index size: {}", size)),
            }
        }

        fn get_non_vertex_index(
            buffer: &[u8],
            offset: &mut usize,
            size: u8,
        ) -> Result<i32, String> {
            match size {
                1 => {
                    if *offset >= buffer.len() {
                        return Err(format!(
                            "Offset {} exceeds buffer bounds {}",
                            *offset,
                            buffer.len()
                        ));
                    }
                    let v = buffer[*offset] as i8;
                    *offset += 1;
                    Ok(v as i32)
                }
                2 => {
                    if *offset + 2 > buffer.len() {
                        return Err(format!(
                            "Offset {} + 2 exceeds buffer bounds {}",
                            *offset,
                            buffer.len()
                        ));
                    }
                    let v = i16::from_le_bytes([buffer[*offset], buffer[*offset + 1]]);
                    *offset += 2;
                    Ok(v as i32)
                }
                4 => get_i32(buffer, offset),
                _ => Err(format!("Invalid non-vertex index size: {}", size)),
            }
        }

        if buffer.len() < 3 || &buffer[0..3] != b"PMX" {
            return Err("Not a PMX file".to_string());
        }
        offset = 4;

        let version = get_f32(&buffer, &mut offset)?;
        if version < 2.0 || version > 2.2 {
            // Continue but version may not be fully supported
        }

        let globals_count = get_u8(&buffer, &mut offset)?;
        if globals_count < 8 {
            return Err(format!(
                "Invalid globalsCount: {}, expected at least 8",
                globals_count
            ));
        }

        encoding = get_u8(&buffer, &mut offset)?;
        additional_vec4_count = get_u8(&buffer, &mut offset)?;
        vertex_index_size = get_u8(&buffer, &mut offset)?;
        texture_index_size = get_u8(&buffer, &mut offset)?;
        material_index_size = get_u8(&buffer, &mut offset)?;
        bone_index_size = get_u8(&buffer, &mut offset)?;
        morph_index_size = get_u8(&buffer, &mut offset)?;
        rigid_body_index_size = get_u8(&buffer, &mut offset)?;

        for _ in 8..globals_count {
            get_u8(&buffer, &mut offset)?;
        }

        get_text(&buffer, &mut offset, encoding)?;
        get_text(&buffer, &mut offset, encoding)?;
        get_text(&buffer, &mut offset, encoding)?;
        get_text(&buffer, &mut offset, encoding)?;

        let count = get_i32(&buffer, &mut offset)? as usize;
        vertex_count = count;

        let mut positions = Vec::with_capacity(count * 3);
        let mut normals = Vec::with_capacity(count * 3);
        let mut uvs = Vec::with_capacity(count * 2);
        let mut vertex_joints = Vec::with_capacity(count * 4);
        let mut weights = Vec::with_capacity(count * 4);

        for i in 0..count {
            positions.push(get_f32(&buffer, &mut offset)?);
            positions.push(get_f32(&buffer, &mut offset)?);
            positions.push(get_f32(&buffer, &mut offset)?);
            normals.push(get_f32(&buffer, &mut offset)?);
            normals.push(get_f32(&buffer, &mut offset)?);
            normals.push(get_f32(&buffer, &mut offset)?);
            uvs.push(get_f32(&buffer, &mut offset)?);
            uvs.push(get_f32(&buffer, &mut offset)?);

            offset += additional_vec4_count as usize * 16;

            let weight_type = get_u8(&buffer, &mut offset)?;
            let base = i * 4;

            vertex_joints.resize(base + 4, 0);
            weights.resize(base + 4, 0);
            weights[base] = 255;

            match weight_type {
                0 => {
                    let j0 = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                    vertex_joints[base] = if j0 >= 0 { j0 as u16 } else { 0 };
                }
                1 | 3 => {
                    let j0 = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                    let j1 = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                    let w0f = get_f32(&buffer, &mut offset)?;
                    let w0 = (w0f * 255.0).max(0.0).min(255.0) as u8;
                    let w1 = 255u8.saturating_sub(w0);
                    vertex_joints[base] = if j0 >= 0 { j0 as u16 } else { 0 };
                    vertex_joints[base + 1] = if j1 >= 0 { j1 as u16 } else { 0 };
                    weights[base] = w0;
                    weights[base + 1] = w1;
                    if weight_type == 3 {
                        offset += 36;
                    }
                }
                2 | 4 => {
                    for k in 0..4 {
                        let j = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                        vertex_joints[base + k] = if j >= 0 { j as u16 } else { 0 };
                    }
                    let wf = [
                        get_f32(&buffer, &mut offset)?,
                        get_f32(&buffer, &mut offset)?,
                        get_f32(&buffer, &mut offset)?,
                        get_f32(&buffer, &mut offset)?,
                    ];
                    let ws = [
                        wf[0].max(0.0).min(1.0),
                        wf[1].max(0.0).min(1.0),
                        wf[2].max(0.0).min(1.0),
                        wf[3].max(0.0).min(1.0),
                    ];
                    let w8 = [
                        (ws[0] * 255.0).round() as u8,
                        (ws[1] * 255.0).round() as u8,
                        (ws[2] * 255.0).round() as u8,
                        (ws[3] * 255.0).round() as u8,
                    ];
                    let sum: u16 = w8.iter().map(|&w| w as u16).sum();
                    if sum == 0 {
                        weights[base] = 255;
                    } else {
                        let scale = 255.0 / sum as f32;
                        let mut accum = 0u8;
                        for k in 0..3 {
                            let v = ((w8[k] as f32 * scale).max(0.0).min(255.0).round()) as u8;
                            weights[base + k] = v;
                            accum = accum.saturating_add(v);
                        }
                        weights[base + 3] = 255u8.saturating_sub(accum);
                    }
                }
                _ => return Err(format!("Invalid bone weight type: {}", weight_type)),
            }

            offset += 4;
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        let mut indices = Vec::with_capacity(count);
        for _ in 0..count {
            indices.push(get_vertex_index(&buffer, &mut offset, vertex_index_size)? as u32);
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        let mut textures = Vec::with_capacity(count);
        for _ in 0..count {
            let texture_name = get_text(&buffer, &mut offset, encoding)?;
            let name = texture_name
                .split('/')
                .last()
                .unwrap_or(&texture_name)
                .to_string();
            textures.push(Texture {
                path: texture_name,
                name,
            });
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        let mut materials = Vec::with_capacity(count);
        for _ in 0..count {
            let name = get_text(&buffer, &mut offset, encoding)?;
            get_text(&buffer, &mut offset, encoding)?;
            let diffuse = vec![
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
            ];
            let specular = vec![
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
            ];
            get_f32(&buffer, &mut offset)?;
            let ambient = vec![
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
                get_f32(&buffer, &mut offset)?,
            ];
            get_u8(&buffer, &mut offset)?;
            get_f32(&buffer, &mut offset)?;
            get_f32(&buffer, &mut offset)?;
            get_f32(&buffer, &mut offset)?;
            get_f32(&buffer, &mut offset)?;
            get_f32(&buffer, &mut offset)?;
            get_non_vertex_index(&buffer, &mut offset, texture_index_size)?;
            get_non_vertex_index(&buffer, &mut offset, texture_index_size)?;
            get_u8(&buffer, &mut offset)?;
            let is_shared_toon = get_u8(&buffer, &mut offset)? == 1;
            if is_shared_toon {
                get_u8(&buffer, &mut offset)?;
            } else {
                get_non_vertex_index(&buffer, &mut offset, texture_index_size)?;
            }
            get_text(&buffer, &mut offset, encoding)?;
            get_i32(&buffer, &mut offset)?;
            materials.push(Material {
                name,
                diffuse,
                specular,
                ambient,
            });
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        let mut bones = Vec::with_capacity(count);
        let mut abs_bones: Vec<(String, i32, f32, f32, f32)> = Vec::with_capacity(count);

        for _ in 0..count {
            let name = get_text(&buffer, &mut offset, encoding)?;
            get_text(&buffer, &mut offset, encoding)?;
            let x = get_f32(&buffer, &mut offset)?;
            let y = get_f32(&buffer, &mut offset)?;
            let z = get_f32(&buffer, &mut offset)?;
            let parent_index = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
            get_i32(&buffer, &mut offset)?;
            let flags = get_u16(&buffer, &mut offset)?;

            const FLAG_TAIL_IS_BONE: u16 = 0x0001;
            if (flags & FLAG_TAIL_IS_BONE) != 0 {
                get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
            } else {
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
            }

            const FLAG_APPEND_ROTATE: u16 = 0x0100;
            const FLAG_APPEND_MOVE: u16 = 0x0200;
            if (flags & (FLAG_APPEND_ROTATE | FLAG_APPEND_MOVE)) != 0 {
                get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                get_f32(&buffer, &mut offset)?;
            }

            const FLAG_AXIS_LIMIT: u16 = 0x0400;
            if (flags & FLAG_AXIS_LIMIT) != 0 {
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
            }

            const FLAG_LOCAL_AXIS: u16 = 0x0800;
            if (flags & FLAG_LOCAL_AXIS) != 0 {
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
            }

            const FLAG_EXTERNAL_PARENT: u16 = 0x2000;
            if (flags & FLAG_EXTERNAL_PARENT) != 0 {
                get_i32(&buffer, &mut offset)?;
            }

            const FLAG_IK: u16 = 0x0020;
            if (flags & FLAG_IK) != 0 {
                get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                get_i32(&buffer, &mut offset)?;
                get_f32(&buffer, &mut offset)?;
                let links_count = get_i32(&buffer, &mut offset)?;
                for _ in 0..links_count {
                    get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                    let has_limit = get_u8(&buffer, &mut offset)? == 1;
                    if has_limit {
                        get_f32(&buffer, &mut offset)?;
                        get_f32(&buffer, &mut offset)?;
                        get_f32(&buffer, &mut offset)?;
                        get_f32(&buffer, &mut offset)?;
                        get_f32(&buffer, &mut offset)?;
                        get_f32(&buffer, &mut offset)?;
                    }
                }
            }

            abs_bones.push((name, parent_index, x, y, z));
        }

        for i in 0..count {
            let (name, parent_index, x, y, z) = &abs_bones[i];
            let bind_translation = if *parent_index >= 0 && (*parent_index as usize) < count {
                let (_, _, px, py, pz) = &abs_bones[*parent_index as usize];
                math::Vec3 {
                    x: x - px,
                    y: y - py,
                    z: z - pz,
                }
            } else {
                math::Vec3 {
                    x: *x,
                    y: *y,
                    z: *z,
                }
            };
            bones.push(Bone {
                name: name.clone(),
                parent_index: *parent_index,
                bind_translation,
            });
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        if count > 100000 {
            return Err(format!("Suspicious morph count: {}", count));
        }

        let mut morphs = Vec::with_capacity(count);

        for _ in 0..count {
            let name = get_text(&buffer, &mut offset, encoding)?;
            get_text(&buffer, &mut offset, encoding)?;
            get_u8(&buffer, &mut offset)?;
            let morph_type = get_u8(&buffer, &mut offset)?;
            let offset_count = get_i32(&buffer, &mut offset)? as usize;

            let mut vertex_offsets = Vec::new();
            let mut group_references = Vec::new();

            match morph_type {
                0 => {
                    for _ in 0..offset_count {
                        let morph_index =
                            get_non_vertex_index(&buffer, &mut offset, morph_index_size)?;
                        let ratio = get_f32(&buffer, &mut offset)?;
                        if morph_index >= 0 {
                            group_references.push((morph_index as usize, ratio));
                        }
                    }
                }
                1 => {
                    for _ in 0..offset_count {
                        let vertex_index =
                            get_vertex_index(&buffer, &mut offset, vertex_index_size)? as usize;
                        let x = get_f32(&buffer, &mut offset)?;
                        let y = get_f32(&buffer, &mut offset)?;
                        let z = get_f32(&buffer, &mut offset)?;
                        if vertex_index < vertex_count {
                            vertex_offsets.push((vertex_index, [x, y, z]));
                        }
                    }
                }
                2 => {
                    for _ in 0..offset_count {
                        get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                        offset += 6 * 4;
                    }
                }
                3 | 4 | 5 | 6 | 7 => {
                    for _ in 0..offset_count {
                        get_vertex_index(&buffer, &mut offset, vertex_index_size)?;
                        offset += 2 * 4;
                    }
                }
                8 => {
                    for _ in 0..offset_count {
                        get_non_vertex_index(&buffer, &mut offset, material_index_size)?;
                        get_u8(&buffer, &mut offset)?;
                        for _ in 0..28 {
                            get_f32(&buffer, &mut offset)?;
                        }
                    }
                }
                _ => {
                    return Err(format!("Unknown morph type: {}", morph_type));
                }
            }

            morphs.push(Morph {
                name,
                morph_type,
                vertex_offsets,
                group_references,
            });
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        if count > 100000 {
            return Err(format!("Suspicious display frame count: {}", count));
        }
        for _ in 0..count {
            get_text(&buffer, &mut offset, encoding)?;
            get_text(&buffer, &mut offset, encoding)?;
            get_u8(&buffer, &mut offset)?;
            let element_count = get_i32(&buffer, &mut offset)? as usize;
            for _ in 0..element_count {
                let element_type = get_u8(&buffer, &mut offset)?;
                match element_type {
                    0 => {
                        get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
                    }
                    1 => {
                        get_non_vertex_index(&buffer, &mut offset, morph_index_size)?;
                    }
                    _ => {}
                }
            }
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        if count > 10000 {
            return Err(format!("Suspicious rigidbody count: {}", count));
        }
        let mut rigidbodies = Vec::with_capacity(count);
        for _ in 0..count {
            let name = get_text(&buffer, &mut offset, encoding)?;
            let english_name = get_text(&buffer, &mut offset, encoding)?;
            let bone_index = get_non_vertex_index(&buffer, &mut offset, bone_index_size)?;
            let group = get_u8(&buffer, &mut offset)?;
            let collision_mask = get_u16(&buffer, &mut offset)?;
            let shape_val = get_u8(&buffer, &mut offset)?;
            let shape = match shape_val {
                0 => RigidbodyShape::Sphere,
                1 => RigidbodyShape::Box,
                2 => RigidbodyShape::Capsule,
                _ => return Err(format!("Invalid rigidbody shape: {}", shape_val)),
            };
            let size_x = get_f32(&buffer, &mut offset)?;
            let size_y = get_f32(&buffer, &mut offset)?;
            let size_z = get_f32(&buffer, &mut offset)?;
            let pos_x = get_f32(&buffer, &mut offset)?;
            let pos_y = get_f32(&buffer, &mut offset)?;
            let pos_z = get_f32(&buffer, &mut offset)?;
            let rot_x = get_f32(&buffer, &mut offset)?;
            let rot_y = get_f32(&buffer, &mut offset)?;
            let rot_z = get_f32(&buffer, &mut offset)?;
            let mass = get_f32(&buffer, &mut offset)?;
            let linear_damping = get_f32(&buffer, &mut offset)?;
            let angular_damping = get_f32(&buffer, &mut offset)?;
            let restitution = get_f32(&buffer, &mut offset)?;
            let friction = get_f32(&buffer, &mut offset)?;
            let type_val = get_u8(&buffer, &mut offset)?;
            let type_ = match type_val {
                0 => RigidbodyType::Static,
                1 => RigidbodyType::Dynamic,
                2 => RigidbodyType::Kinematic,
                _ => return Err(format!("Invalid rigidbody type: {}", type_val)),
            };
            rigidbodies.push(Rigidbody {
                name,
                english_name,
                bone_index,
                group,
                collision_mask,
                shape,
                size: math::Vec3 {
                    x: size_x,
                    y: size_y,
                    z: size_z,
                },
                shape_position: math::Vec3 {
                    x: pos_x,
                    y: pos_y,
                    z: pos_z,
                },
                shape_rotation: math::Vec3 {
                    x: rot_x,
                    y: rot_y,
                    z: rot_z,
                },
                mass,
                linear_damping,
                angular_damping,
                restitution,
                friction,
                type_,
            });
        }

        let count = get_i32(&buffer, &mut offset)? as usize;
        if count > 10000 {
            return Err(format!("Suspicious joint count: {}", count));
        }
        let mut joints = Vec::with_capacity(count);
        for _ in 0..count {
            let name = get_text(&buffer, &mut offset, encoding)?;
            let english_name = get_text(&buffer, &mut offset, encoding)?;
            let type_ = get_u8(&buffer, &mut offset)?;
            let rigidbody_index_a =
                get_non_vertex_index(&buffer, &mut offset, rigid_body_index_size)?;
            let rigidbody_index_b =
                get_non_vertex_index(&buffer, &mut offset, rigid_body_index_size)?;
            let pos_x = get_f32(&buffer, &mut offset)?;
            let pos_y = get_f32(&buffer, &mut offset)?;
            let pos_z = get_f32(&buffer, &mut offset)?;
            let rot_x = get_f32(&buffer, &mut offset)?;
            let rot_y = get_f32(&buffer, &mut offset)?;
            let rot_z = get_f32(&buffer, &mut offset)?;
            let pos_min_x = get_f32(&buffer, &mut offset)?;
            let pos_min_y = get_f32(&buffer, &mut offset)?;
            let pos_min_z = get_f32(&buffer, &mut offset)?;
            let pos_max_x = get_f32(&buffer, &mut offset)?;
            let pos_max_y = get_f32(&buffer, &mut offset)?;
            let pos_max_z = get_f32(&buffer, &mut offset)?;
            let rot_min_x = get_f32(&buffer, &mut offset)?;
            let rot_min_y = get_f32(&buffer, &mut offset)?;
            let rot_min_z = get_f32(&buffer, &mut offset)?;
            let rot_max_x = get_f32(&buffer, &mut offset)?;
            let rot_max_y = get_f32(&buffer, &mut offset)?;
            let rot_max_z = get_f32(&buffer, &mut offset)?;
            let spring_pos_x = get_f32(&buffer, &mut offset)?;
            let spring_pos_y = get_f32(&buffer, &mut offset)?;
            let spring_pos_z = get_f32(&buffer, &mut offset)?;
            let spring_rot_x = get_f32(&buffer, &mut offset)?;
            let spring_rot_y = get_f32(&buffer, &mut offset)?;
            let spring_rot_z = get_f32(&buffer, &mut offset)?;
            joints.push(Joint {
                name,
                english_name,
                type_,
                rigidbody_index_a,
                rigidbody_index_b,
                position: math::Vec3 {
                    x: pos_x,
                    y: pos_y,
                    z: pos_z,
                },
                rotation: math::Vec3 {
                    x: rot_x,
                    y: rot_y,
                    z: rot_z,
                },
                position_min: math::Vec3 {
                    x: pos_min_x,
                    y: pos_min_y,
                    z: pos_min_z,
                },
                position_max: math::Vec3 {
                    x: pos_max_x,
                    y: pos_max_y,
                    z: pos_max_z,
                },
                rotation_min: math::Vec3 {
                    x: rot_min_x,
                    y: rot_min_y,
                    z: rot_min_z,
                },
                rotation_max: math::Vec3 {
                    x: rot_max_x,
                    y: rot_max_y,
                    z: rot_max_z,
                },
                spring_position: math::Vec3 {
                    x: spring_pos_x,
                    y: spring_pos_y,
                    z: spring_pos_z,
                },
                spring_rotation: math::Vec3 {
                    x: spring_rot_x,
                    y: spring_rot_y,
                    z: spring_rot_z,
                },
            });
        }

        let mut vertex_data = Vec::with_capacity(vertex_count * 8);
        for i in 0..vertex_count {
            let pi = i * 3;
            let ui = i * 2;
            vertex_data.push(positions[pi]);
            vertex_data.push(positions[pi + 1]);
            vertex_data.push(positions[pi + 2]);
            vertex_data.push(normals[pi]);
            vertex_data.push(normals[pi + 1]);
            vertex_data.push(normals[pi + 2]);
            vertex_data.push(uvs[ui]);
            vertex_data.push(uvs[ui + 1]);
        }

        let skinning = Skinning {
            joints: vertex_joints.iter().map(|&j| j as u32).collect(),
            weights: weights.iter().map(|&w| w as f32 / 255.0).collect(),
        };

        Ok(ModelData {
            vertices: vertex_data,
            indices,
            textures,
            materials,
            bones,
            skinning,
            morphs,
            rigidbodies,
            joints,
        })
    }
}
