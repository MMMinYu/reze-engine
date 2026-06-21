// StarRail 材质 shader 的统一 prelude 拼接。
//
// 每个 sr_* 材质文件只需导入这一个 prelude，即可获得完整的 WGSL 模块骨架。
// 材质文件追加自己的常量 + @fragment fn fs() 即可。
//
// 拼接顺序：
//   COMMON_BINDINGS_GROUP01_WGSL  (group 0/1 声明，不含 group 2)
//   STARRAIL_BINDINGS_WGSL        (StarRail 专用 group 2 声明)
//   SAMPLE_SHADOW_WGSL            (3×3 PCF 阴影采样)
//   COMMON_VS_WGSL                (蒙皮顶点着色器)
//   COMMON_FS_OUT_WGSL            (FSOut 输出结构体)
//   STARRAIL_NODES_WGSL           (共享 NPR 辅助函数)
//
// 材质文件拼法：
//   ${STARRAIL_PRELUDE_WGSL}
//   @fragment fn fs(input: VertexOutput) -> FSOut { ... }

import { COMMON_BINDINGS_GROUP01_WGSL, SAMPLE_SHADOW_WGSL, COMMON_VS_WGSL, COMMON_FS_OUT_WGSL } from "../common"
import { NODES_WGSL } from "../nodes"
import { STARRAIL_BINDINGS_WGSL } from "./bindings"
import { STARRAIL_NODES_WGSL } from "./starrail_nodes"

export const STARRAIL_PRELUDE_WGSL =
  NODES_WGSL +
  COMMON_BINDINGS_GROUP01_WGSL +
  STARRAIL_BINDINGS_WGSL +
  SAMPLE_SHADOW_WGSL +
  COMMON_VS_WGSL +
  COMMON_FS_OUT_WGSL +
  STARRAIL_NODES_WGSL
