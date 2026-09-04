# 项目交接说明

给接手这个项目的人 / Agent。读完这份应该能直接开始干活。

> 这个文件在仓库根目录，Claude Code 开新会话时会自动读它，不需要谁手动贴过来。

---

## 1. 项目来源

Fork 自 **Istvan Krisztian Somoracz（NewKrok）** 的两个 MIT 项目：

| 上游 | 变成了这里的 |
|---|---|
| <https://github.com/NewKrok/three-particles> | `packages/three-particles` — 粒子库 |
| <https://github.com/NewKrok/three-particles-editor> | `packages/editor` — 可视化编辑器 |

原来是两个独立仓库，这里合成了一个 monorepo。原始 LICENSE 保留在 `packages/three-particles/LICENSE`。

拥有者：曹雨西（Cao Yuxi），新媒体艺术家。这是他自用的创作工具，不是要回馈上游的通用库。

线上：<https://caoyuxistudio.github.io/threeparticle-CAOModed/>（推 main 自动部署）

---

## 2. 原项目的架构逻辑

**粒子库**（`packages/three-particles`）是纯逻辑，不管 UI。给它一份 config 对象，它吐出一个可以 `add` 进 three.js 场景的粒子系统，每帧调 `updateParticleSystems`。有 CPU 和 WebGPU 两条路径，这个 fork 主要走 WebGPU + TSL。

**编辑器**（`packages/editor`）是个 Svelte 应用，本质是"给那个 config 对象做一套界面"：

```
┌──────────┬──────────────────────┬──────────────┐
│ 左面板    │      three.js 画布     │   右面板      │
│ Svelte   │  （整窗大小，面板浮在上面）│  lil-gui     │
│          │                      │              │
│ Examples │                      │ 粒子参数        │
│ Library  │                      │（发射、形状、    │
│ Textures │                      │  噪声、渲染器…） │
│ Scene ★  │                      │              │
└──────────┴──────────────────────┴──────────────┘
```

关键点：

- **config 就是作品**。一个 JSON 描述整个效果，能存能读能复制粘贴。
- 右面板由 `entries/*.ts` 里一堆 lil-gui 定义拼出来，改的是同一个 config 对象。
- `_editorData` 是 config 里给编辑器自己用的一块，库不读它。
- 画布是**整窗尺寸**，两侧面板是浮在它上面的 DOM。写视口相关代码时这点很容易踩坑（见下方"坑"）。

---

## 3. 我们在做什么

把它从"单个粒子发射器的调参工具"改造成 **粒子艺术装置的实时编辑器**——概念上是个极简版 Blender：有场景、有灯、有相机、有后期，所见即所得。

### 已经做完的

**Scene 面板**（★ 那一栏，本 fork 新增）。可以往场景里放这些原子物体：

| 类型 | 说明 |
|---|---|
| `BOX` `SPHERE` | 基础几何体 |
| `POINT_LIGHT` `DIRECTIONAL_LIGHT` | 灯 |
| `LIGHT_PROBE` | 环境光探针，可烘焙 |
| `FRAME` | **画框**。按内框长宽 + 边框粗细 + 深度调，正面和内框洞壁两套材质 |
| `CAMERA` | **输出相机**。作品最终是给这个机位构图的 |
| `ENVIRONMENT` | **全景环境光**。JPEG/PNG/WebP/HDR/EXR，照明 + 反射 + 可选背景 |

**几条贯穿的设计**：

- **场景跟着 config 走**。存在 `_editorData.sceneObjects`，保存/复制/加载都带着。config 是自包含的作品描述，不是一堆散参数。
- **Layers 分离**：layer 0 = 作品，layer 1 = 编辑器家具（网格、坐标轴、拖拽手柄、碰撞面手柄）。输出相机只看 layer 0，所以预览里是作品本身。**新加的物体默认在 layer 0，只有家具需要显式标记**——漏标会在预览里露出来，一眼可见；反过来标作品，漏了就是静默消失。
- **输出相机 + 右上角预览窗**。拖左下角红色把手改大小，最大可占屏幕 70%。尺寸会记住。
- **后期属于相机**，不属于编辑器会话。SSR 的开关和参数存在 CAMERA 物体上，跟着 config 走。一个场景可以放多个相机各带各的设置，隐藏其余的就是切换机位。

**Player 显示窗口**（预览窗左边那个按钮，`player.html`）。概念上是 TouchDesigner 的 Window 节点：编辑器留在原地继续调参，第二个窗口只放输出相机的画面，按画幅比例 letterbox，没有任何界面。

- **是独立窗口，不是新 tab**。浏览器会暂停隐藏 tab 的 rAF，所以做成 tab 的话你一看它编辑器就冻住了。
- **两个独立实例**。`world.ts` / `scene-objects.ts` 都是模块级单例，同一个页面开不出第二份；换个页面就各拿一套。代价是两个 WebGPU device，贴图各存一份，两边帧率都掉一些——这是调试形态刻意接受的成本。
- **BroadcastChannel 实时同步**。改一个滑块或拖一盏灯，120ms 节流后推过去。粒子 config 和场景走两条消息：场景按 id 做增量 `updateSceneObject`，画框几何和全景 PMREM 的缓存因此不会被打掉。
- **贴图不上线**。同源共享 localStorage，显示端自己读，所以消息只有几 KB。将来 Player 独立成站再把 `embeddedTextures` 塞回去。
- **显示端只读**。它的 `persist()` 不写 localStorage——同源，否则会覆盖你正在编辑的场景。
- 共用的那份逻辑抽在 `particle-factory.ts`（config → 粒子系统）和 `simulation.ts`（发射器的内置运动），两边调同一个函数，不会漂移。

### 当前状态

- 测试场景是内置 example **WIP-Test**（`packages/editor/public/examples/wip-test/`），存在磁盘上，清空 localStorage 也在
- 控制台 harness `public/__ai-test.js`，当前基线 **64/64**

---

## 4. 下一步：把 Player 变成放映端

现在的 `player.html` 是**调试形态**：跟编辑器同源、同一个 dev server，靠 BroadcastChannel 拿 config，编辑器在旁边一起渲染。它证明了管线通，但不是装置现场要跑的东西。

要变成放映端，还差两步：

**1. 脱离编辑器。** config 来源从 BroadcastChannel 换成粘贴 JSON 或读 URL，`embeddedTextures` 塞回快照里（现在靠共享 localStorage 省掉了），页面就能独立部署。**交付方式：把 config 粘贴进去就能跑。**

**2. 单实例高效渲染。** 现在为了能一边编辑一边看，两个 WebGPU 实例同时跑，资源各存一份。真正上墙时只有 Player 在跑，那条路径应该按最高效率来——编辑器那套 layer 分离、家具、预览 RT 一概不要。

编辑器负责创作，Player 负责放映。装置现场跑的是 Player。

这也是为什么前面那些设计要那样做：config 自包含、场景存进 config、后期归相机、layer 分离——都是为了让"复制一段 JSON 过去就能完整重现"这件事成立。

---

## 5. 上手须知

### 跑起来

```bash
cd packages/three-particles && npm run build   # 库要先构建，editor 从 dist 解析它
cd ../editor && npm run dev                    # 8080
```

改源码会自动重新打包，但**不会自动刷新页面**，要手动刷新。

### 验证改动

别靠一路点击加截图，慢且容易骗自己。两次调用跑完：

```js
// 1. 刷新页面
window.location.reload()

// 2. 跑全部断言
await fetch('/__ai-test.js').then(r=>r.text()).then(eval)
await __t.report()          // 存取回归
__t.cameraReport()          // 相机 / layer / 预览
await __t.environmentReport()
await __t.frameReport()
await __t.playerReport()    // 显示窗口的通信契约
```

加新功能就往对应的 report 里加断言。

`environmentReport` / `frameReport` / `playerReport` 都是异步的，**不能塞进同一次批量调用**——排队的后续调用之间浏览器面板会隐藏，rAF 被暂停，等场景重建的地方会量到上一帧的几何，报假失败。一个 report 一次调用。

同一个原因还会坑另一件事：**别在自动化面板里量帧率**。面板可见性会高频抖动（实测 356ms 内 6 次 visible/hidden 切换），rAF 跟着断续，数出来的 FPS 可以低到 1，看起来像性能塌了，其实什么都没发生。要看真实帧率就看画面左上角编辑器自己那个 stats 读数。

### 技术栈

three **r182**、`WebGPURenderer`、TSL 节点材质、Svelte 5、Rollup。

### 已知的坑

**画布不是从窗口左上角开始的**——上面有 47px 工具栏。渲染器的视口/裁剪坐标相对 canvas，鼠标事件的 `clientX/Y` 相对窗口。混用会得到"画在这里、点在那里"的 bug，截图完全看不出来。统一用 `canvasBounds()` 换算。

**WebGPU 的 viewport 原点是左上角**，和 WebGL 的左下相反。

**TSL 会吞掉 shader 里的异常**。表现是"没报错也没效果"，所有输入单独看都对。SSR 卡了两天就是这个——传进去的节点缺 `.sample()` 方法，每次采样都抛异常。遇到这类情况，直接往 shader 内部插探针读它自己看到的值，不对称的地方就是 bug。

**post-processing 不能被 scissor 裁到角落**——它内部的 scene pass 会跟着被裁，整个画布变黑。预览是先渲进离屏 RT 再贴过去的。

**roughness 上限就是 1**，抬滑块上限没有意义（着色模型和 SSR 的 lod 计算都会截断）。要更模糊用相机的 `resolution`（降分辨率追踪，更省不是更费）或 `blur`。

### 工作习惯

- 本地改、本地验证，**不要边改边推**。收工时集中提交，commit message 写清楚做了什么。
- 推公开仓库前先确认。推 main 会自动部署上线。
- 沟通简洁客观，不需要铺垫和主动建议。

---

## 6. 还欠的账

- 新增的功能代码基本没有单元测试，提交时绕过了覆盖率门禁（浏览器 harness 补了一部分，但不是一回事）
- `world.ts` 有 `window.__world`、`player.ts` 有 `window.__player`，两个调试出口，harness 依赖它们，正式发布前要处理
- 粒子目前不能投射/接收阴影：粒子材质用 `material.vertexNode` 驱动顶点阶段，而阴影 pass 不跑那一段
- 超过 4MB 的全景图存不进 localStorage，当前会话可用但刷新即失
- 只有发射器的内置运动（`simulation.ts`）在两个窗口间对了相位；粒子本身各自独立模拟，永远不会逐帧一致
