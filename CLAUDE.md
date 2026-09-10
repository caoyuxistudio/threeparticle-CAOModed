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
| `FRAME` | **画框**。按内框长宽 + 边框粗细 + 深度调，正面和内框洞壁两套材质；开口可以**圆角**：四个角各自一个半径（面板上按全部 / 上一对 / 下一对调），开口本身仍是矩形，圆角外面用一块"遮罩"填上（子网格，遮罩色默认黑、洞壁沿用边缘材质），预设是苹果设备屏幕圆角占屏幕宽度的比例乘以开口宽度 |
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
- **点开显示窗口时会把它的链接复制到剪贴板**并弹 snackbar 提示（剪贴板不可用时只显示链接）。
- **编辑器每次推送也会把最新的发射器 config 存进 localStorage**（`particle-system-editor/player-snapshot`，含 `elapsed` 和 `savedAt`；场景本来就由 scene-objects 持久化）。显示端 hello 后 1.2s 没人应答就读它，之后每 5s 再 hello 一次直到有活的编辑器；从后台回到前台时也会读一次，比屏幕上的新就换。这是**手机**上唯一能工作的方式：iOS 上 `window.open` 开的是 tab，后台 tab 整个冻结，编辑器和显示端永远不可能同时活着，靠 BroadcastChannel 握手必然失败；靠存储就是「在这个 tab 改、切到那个 tab 看」。同样也让粘贴链接在编辑器关掉后仍能显示最后一版。
- **手机上的全屏**：显示端单击（触摸）会浮出一个 Full screen 按钮 3 秒，点它等于按 F；iPhone 的浏览器没有元素全屏 API 时会提示改用「添加到主屏幕」。`touch-action: manipulation` 关掉了双击缩放。
- **演示模式**（播放窗口按钮正下方那个 `fullscreen` 按钮，`presentation.ts`）：不开第二个页面，**这个窗口自己变成显示端**——全部面板 display:none，视口和角落预览都不画，输出相机按自己的画幅 letterbox 直出画布（走的就是 `renderPlayer`），能 requestFullscreen 就一起要。手机上这是唯一可行的形态（第二个 tab 会把编辑器冻住）；桌面上是「看一眼作品」的快捷键。Esc、全屏被浏览器退出、或点一下屏幕浮出的 Exit 都能回来；浮出的条上还有 FPS 开关。进去时取消选中（手柄的射线用的是编辑器相机）、关掉 orbit，出来时全部复原。`postProcessing.outputColorTransform` 在演示时为 true（直出画布），退出后恢复 false（预览 RT 那条路），别把这两处弄反。
- 共用的那份逻辑抽在 `particle-factory.ts`（config → 粒子系统）和 `simulation.ts`（发射器的内置运动），两边调同一个函数，不会漂移。
- **显示端有帧数表**，窗口左上角，`S` 隐藏。它存在的理由就是两个窗口画同一份东西一定比一个贵，而唯一诚实的读数在真正要看的那个窗口里。
- **显示端每 2 秒发一次 `ping`，编辑器 6 秒没听到就当它没了**（`isLinked()`），解除挂起、停止推送。没有这个，手动打开的播放页被直接杀掉（没来得及发 `bye`）会让编辑器永久挂起、视频永久暂停——实测踩过。harness 的 playerReport 因此在检查期间自己模拟 ping。
- **编辑器失焦就停止绘制**。显示窗口开着、编辑器不是当前窗口时，编辑器的帧循环整个跳过：省掉深度 pass、视口、以及预览那一遍完整的反射管线。画布调暗，中间浮一张 **Move to Player View** 卡片，点它把显示窗口调到前面；点视口任何地方就恢复。
  - 停的是**绘制**，不是工作。面板是 DOM，照常可用；参数改动走 `persist()` 而不是帧循环，所以挂起状态下编辑器就是个控制台——滑块在这边，画面在那边。所以调暗的是画布本身，不是盖一层全窗口的罩子：罩子会把 lil-gui 一起压暗，而那正是还能用的那一半。
  - 挂起同时把模拟时钟按 PAUSE 的那套记账停掉，否则回来那一帧 `cycleData.now` 会跳过整段挂起时间，发射器一次性全吐出来。会记住你自己是不是本来就按了 PAUSE。
  - 省不掉的是两个 WebGPU device 和两份贴图的显存——那是两个页面实例的固有成本，只有下面说的「Player 脱离编辑器」才去得掉。

**视频作为 color source**（Textures 面板的 **Add Video**）。`particleColorInstance` 原来只吃一张图：粒子出生时在 CPU 上查一次像素，拿到起始颜色和亮度→噪声系数。现在同一个入口也吃视频，静音循环播放，粒子出生时采的是当时正在播的那一帧。

- **为什么不用 GPU 纹理**。库里 color source 的全部用途就是出生那一刻的 CPU 像素查表，视频从头到尾不需要上传成 GPU 纹理，`importExternalTexture` / `copyExternalImageToTexture` 那些优化跟这条路径无关。解码走浏览器硬件（macOS 上是 VideoToolbox），主线程零成本；唯一的开销是**把当前帧读回 CPU**。
- **读回的做法**（`packages/three-particles/src/js/effects/three-particles/color-instance-sampler.ts`）：
  - 只在视频**真的出了新帧**时读（`requestVideoFrameCallback`，跟视频帧率走，不跟渲染帧率走）；只在**有粒子出生**时才需要（没人采样就不读）。
  - 读进一个有上限的网格（`particleColorInstance.sampleSize`，默认 512，2048² 的视频也只读 1MB），静态图仍按原尺寸只读一次。
  - 第一帧在主线程用 canvas 同步读一次（保证一开始就有颜色），之后每帧 `new VideoFrame(video)`（只是个句柄）转交给一个 **Worker**，在 `OffscreenCanvas` 里缩放、`getImageData`、把 buffer 转移回来。主线程每帧只剩 0.0–0.2ms。
  - 实测（2048²、30fps、编辑器满负荷渲染时）：worker 内每帧中位数 6ms，那是等共享 GPU 队列的同步停顿，落在 worker 自己的线程上；如果留在主线程就是每秒 30 次 × 6ms。`willReadFrequently: true` 的 CPU 路径每帧 12ms（先把整帧 2048² 转成 RGBA），WebCodecs `copyTo` 全分辨率 13–17ms，都更差。
  - 开销发布在 `map.userData.colorInstanceReadback`（count / lastMs / workerMs / mode），harness 和任何人都能读。
- **存储分开放**。元数据（名字、时长、缩略图）在 localStorage `particle-system-editor/video-textures`，跟图片列表并排；**字节在 IndexedDB**（库 `three-particles-editor`，store `videos`，key = 名字）。一分钟 H.264 有几十 MB，localStorage 装不下；IndexedDB 同源共享，显示窗口直接读，线上不传字节。也支持 **URL 来源**：只存地址，保存 config 时写进 `_editorData.embeddedVideos`，别处加载能自动补上；本地上传的视频只能以名字随 config 走（跟内置贴图一样）。
- **播放元素不能藏死**：放在一个 2px、opacity 0.01 的固定容器里而不是 `display:none`——不参与合成的视频不会触发 `requestVideoFrameCallback`；也不能从 DOM 里拿掉——按规范移除即暂停。编辑器挂起时把视频一起 `pause()`，回来再 `play()`。
- 显示窗口启动时读同一份列表；编辑器在它开着之后才加的视频，它按名字自己去 IndexedDB 取（`ensureVideoTexture`）。
- 调试出口 `window.__videoTextures`（addFile / addUrl / remove / entries / get），harness 靠它绕过文件对话框。
- Textures 面板自己持有一份列表拷贝，所以注册表每次写入都会在 `window` 上发 `video-textures-changed`，面板监听它刷新（也监听跨窗口的 `storage`）。点 **Use** 前会先确认名字真的有注册，没有就尝试从 IndexedDB 重新注册，再不行明确报错——曾经有过一张过期卡片被点中、粒子静默变黑的事。

**粒子面板的两处小改**：Particle Color Instance 现在紧跟在 Noise 下面（它的亮度→curl 系数本来就是 Noise 的一部分）；Mesh 一节在 lit 模式下多了 `roughness`（默认 0.65）和 `metalness`（默认 0）两个滑块，存在 `renderer.mesh` 里随 config 走。粒子的颜色本身就是它的 albedo（起始色 / 渐变 / Color Instance 采到的像素），这两个滑块决定灯光怎么落在上面；metalness > 0 的粒子会被 SSR 视为反射面。

**Opacity over lifetime 有了自己的一节**，紧跟在 Size over lifetime 下面，同一套 Edit Curve。它接管了 `opacityOverLifetime`；渐变编辑器（原来叫 Color & Opacity）改成只管颜色，每个色标的 alpha 滑块隐藏了，旧 config 里的 alpha 数据原样保留但不再被编辑。两个编辑器写同一个字段时，谁最后动谁赢，这是拆开的原因。注意 `renderer.transparent` 关着的时候 alpha 不参与混合，曲线唯一可见的效果是低于丢弃阈值处的硬切——要淡入淡出必须开 transparent（密集的云再考虑关 depthWrite）。

**手机上的性能工作流**。手机没有能模拟的东西——iOS 模拟器跑在 Mac 的 GPU 上，帧率毫无参考价值，DevTools 也只能限 CPU 不能限 GPU。所以仪器搬到手机上去：
- **Perf HUD**（编辑器演示模式的浮条上有 Perf 按钮，播放页点一下屏幕也有，键盘 `P`）显示两秒滚动窗口的 fps / 最差帧、实际渲染像素和 scale、粒子预算、SSR 参数、视频读回模式和耗时、设备信息，**Copy report** 把这些复制成文本，贴回对话就是一次测量。
- HUD 上的按钮一次只动一个变量：**scale**（像素比上限 0.75 / 1 / 1.5 / 2 / 设备原生）、**SSR 开关**、**SSR res**、**particles 预算 25% / 50% / 100%**。都是运行时临时的，不写进 config。用法就是每按一档记一个 fps，贴回来。
- **触摸设备的像素比默认封顶 2**（`world.ts` 的 `renderScaleCap`）。iPhone 报 3，3× 画布加 SSR 是 20 帧的头号嫌疑；2 已经是肉眼分不出的上限，桌面不受影响。
- 帧率的唯一可信读数是手机自己屏幕上的那个数；这里的面板测不了它。

**相机画幅**：CAMERA 的 output frame 里除了固定比例，多了 **iPhone 17 Pro Max**（440×956 逻辑像素，0.4603）和 **Fit window**（`aspect: 0`，跟着当前窗口走——播放页和演示模式里就是彻底铺满、没有黑边；编辑器预览则取编辑器窗口的比例）。铺满意味着构图随屏幕变，所以要精确构图用 iPhone 预设、从主屏幕图标打开来看。

**显示端是 cover 不是 contain**（`fitPlayerCanvas`）：画布永远铺满窗口，相机取窗口的比例，视场按"覆盖预设构图"来算——窗口比预设窄就保留构图的高度裁两侧，比预设宽就保留宽度裁上下。预设（含 iPhone 那两个）只决定构图，编辑器预览按预设显示，退出演示时把相机恢复到预设。不留 letterbox 是有意的：目标是实打实的全屏。

**iOS 27 beta 主屏幕模式的极限**（实测 iPhone 17 Pro Max、iOS 27 beta）：网页视图永远只有"屏幕减状态栏"那么高（894 / 956），CSS 的 `100lvh` 却报 956。`black-translucent` 把视图整个挪到状态栏底下、底部留 62px 黑；`black` 让视图待在状态栏下面、顶部是黑色状态栏。两种都试过把画布画出视图外：那一段就是不显示，只会裁掉画面一边。`display: fullscreen` 试过，iOS 不认；去掉 manifest 的 `display` 走 `apple-mobile-web-app-capable` 老路径也试过，同样 894。所以网页在这台机器上到头了，收尾方案是：状态栏 `default`，页面从状态栏下面铺满到底；演示模式和播放页每半秒把画面顶边的平均色写进 `theme-color`，状态栏（以及 Safari 里的顶栏和底栏）跟着染色，看上去像画面延续过去——Apple 自己的页面就是这么"全屏"的。画布严格等于视图，cover 模式保证视图内没黑边。要真的压到状态栏底下，只能做原生壳（WKWebView 隐藏状态栏）。相机预设 **iPhone 17 Pro Max · app** = 440×894 就是这个视图。HUD 的 `viewport:` 一行报 doc / visual / screen / 各 vh 单位 / 安全区 / gap，再遇到视口问题先看它。

**iPhone 上去掉 Safari 的栏**（Safari 里进演示模式时会弹一次提示说这件事）：iPhone 的 Safari 没有元素全屏 API（iPad 才有），`requestFullscreen` 会被拒绝，演示模式在 Safari 里只能做到页面级全屏，底栏还在。唯一的路是 **添加到主屏幕**：两个页面都带了 `apple-mobile-web-app-capable`、`black-translucent` 状态栏和 `viewport-fit=cover`，manifest 是 `standalone`，从主屏幕图标打开就是无边框的 app 窗口，440×956 全部可用。HUD、演示浮条、播放页按钮都按 `env(safe-area-inset-*)` 避开灵动岛和 Home 指示条。

**手机竖屏的布局**：两侧面板之间不足 220px 时算窄屏，预览窗改为占画布整个宽度、放在右侧面板折叠后的标题条下面，旁边两个按钮跟着——否则竖屏时它们全被面板盖住，只有横屏才点得到演示模式。手机顶栏的汉堡菜单里也有 **Full screen**，和按钮等价。主屏幕模式下页面顶到状态栏底下，工具栏加了 `env(safe-area-inset-top)` 的顶部内边距，内容区高度相应扣掉；Safari 和桌面上这个值是 0。

**界面只剩 dark**。light 主题的切换按钮和 localStorage 偏好都删了，`index.html` 无条件只链 `smui-dark.css`（light 的 css 还在编译，只是不再链接）。

### 当前状态

- 测试场景是内置 example **WIP-Test**（`packages/editor/public/examples/wip-test/`），存在磁盘上，清空 localStorage 也在。它引用的是那张山水画；73MB 的那个测试视频进不了仓库
- **WIP-Test-2** 是同一个场景换成视频 color source，竖幅相机。视频是 `public/assets/videos/wechat-20240829.mp4`（1000²、53s、1.6Mbps、10.6MB，随站点部署），config 用 **URL** 引用它（`_editorData.embeddedVideos`），所以任何能打开站点的设备都能播，手机上也是从 Examples 一点就开。这是「资产走 URL、config 走仓库」这条路的第一个样品
- **做一个带视频的 example 的步骤**：把视频放进 `public/assets/videos/`；Textures 面板 **Add Video by URL** 填 `./assets/videos/<文件>`（相对地址，本地和 Pages 都能解析），Use；调好后 Copy，把 JSON 存成 `public/examples/<slug>/config.json`（slug 是名字小写、非字母数字换成连字符），配一张 `preview.webp`，在 `src/examples-config.js` 里加名字。本地上传（Add Video）的视频只在本机浏览器里，带不进 config
- 控制台 harness `public/__ai-test.js`，当前基线 **177/177**（含 `videoReport` 30、`gizmoReport` 12、`playerReport` 41、`presentReport` 32、`frameReport` 15）

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
await __t.playerReport()    // 显示窗口的通信契约 + 编辑器挂起
await __t.videoReport()     // 视频 color source：存储、循环、读回、清理
await __t.gizmoReport()     // 场景物体的拖拽手柄：合成指针事件真的拖一次
await __t.presentReport()   // 演示模式：进、量、出
```

`videoReport` 要能 fetch 到 `./assets-local/AnimateDiff_00013.mp4`。那是个指向仓库旁边 `assets4test/` 的软链，目录整个 gitignore，新机器上要重建：

```bash
ln -sfn "$PWD/assets4test/AnimateDiff_00013.mp4" packages/editor/public/assets-local/AnimateDiff_00013.mp4
```

加新功能就往对应的 report 里加断言。

`environmentReport` / `frameReport` / `playerReport` 都是异步的，**不能塞进同一次批量调用**——排队的后续调用之间浏览器面板会隐藏，rAF 被暂停，等场景重建的地方会量到上一帧的几何，报假失败。一个 report 一次调用。

同一个原因还会坑另一件事：**别在自动化面板里量帧率**。面板可见性会高频抖动（实测 356ms 内 6 次 visible/hidden 切换），rAF 跟着断续，数出来的 FPS 可以低到 1，看起来像性能塌了，其实什么都没发生。

真实帧率只能在人自己的浏览器里读：编辑器看左上角那个 stats，显示窗口看它自己左上角那个（`S` 隐藏）。两个窗口一起跑的时候，**要看的是显示窗口那个数**——编辑器失焦就停画了，它那个读数是冻住的，所以挂起时会被压暗，提醒你别去读它。

挂起相关的断言只能验结构（帧数确实不再前进、焦点回来确实恢复、卡片层级低于面板），**省了多少帧验不了**，别写成好像验过了。

同理，`videoReport` 里标着「needs frames / needs a visible window」的几条依赖 rAF 和 `requestVideoFrameCallback`，面板隐藏时会假失败；读回的**成本数字**（worker 里几毫秒、主线程零点几毫秒）是在真实负载下另外量的，harness 只断言量级。

### 技术栈

three **r182**、`WebGPURenderer`、TSL 节点材质、Svelte 5、Rollup。

### 已知的坑

**画布不是从窗口左上角开始的**——上面有 47px 工具栏。渲染器的视口/裁剪坐标相对 canvas，鼠标事件的 `clientX/Y` 相对窗口。混用会得到"画在这里、点在那里"的 bug，截图完全看不出来。统一用 `canvasBounds()` 换算。

**WebGPU 的 viewport 原点是左上角**，和 WebGL 的左下相反。

**放到 layer 1 的东西，射线检测也要跟着改**。`Raycaster.layers` 默认只看 layer 0，TransformControls 内部找手柄用的也是一个 Raycaster。把手柄 `markAsEditorOnly` 之后如果不给对应的 raycaster `layers.enable(EDITOR_LAYER)`，手柄画得出来但 hover 不亮、拖不动，而且没有任何报错——场景物体、力场、碰撞面三套手柄都这样坏过一轮。新加任何家具层上的可点击物，配套的 raycaster 一起改。

**TSL 会吞掉 shader 里的异常**。表现是"没报错也没效果"，所有输入单独看都对。SSR 卡了两天就是这个——传进去的节点缺 `.sample()` 方法，每次采样都抛异常。遇到这类情况，直接往 shader 内部插探针读它自己看到的值，不对称的地方就是 bug。

**post-processing 不能被 scissor 裁到角落**——它内部的 scene pass 会跟着被裁，整个画布变黑。预览是先渲进离屏 RT 再贴过去的。

**PostProcessing 往离屏 RT 里渲染时也会烤进输出变换**（tone mapping + linear→sRGB），不管目标是不是画布。预览把它渲进 RT 再用 MeshBasicNodeMaterial 贴到画布上，贴的那一步渲染器又编码一次——中间调被抬高、饱和度流失，粒子看起来发灰发白，而且只在开 SSR 时出现（实测均值 44 变 114）。现在编辑器里 `postProcessing.outputColorTransform = isPlayer()`：预览 RT 存线性光（HalfFloat），贴回时只编码一次；显示端直出画布，保留变换。以后要加 tone mapping 记得预览这条路会跳过它。

**roughness 上限就是 1**，抬滑块上限没有意义（着色模型和 SSR 的 lod 计算都会截断）。要更模糊用相机的 `resolution`（降分辨率追踪，更省不是更费）或 `blur`。

**canvas 读回三件事**：`getContext('2d')` 不显式写 `willReadFrequently: false`，Chrome 会在几次 `getImageData` 之后把整个 canvas 降到 CPU（对视频意味着每帧先在 CPU 上转换整帧）；GPU canvas 的 `getImageData` 是等 GPU 队列的同步停顿，页面渲染越重停得越久，所以读回要么不在主线程做，要么别做；隐藏文档里 rAF 和 `requestVideoFrameCallback` 都不跑，`display:none` 的视频也不触发后者。

### 工作习惯

- 本地改、本地验证，**不要边改边推**。收工时集中提交，commit message 写清楚做了什么。
- 推公开仓库前先确认。推 main 会自动部署上线。
- 沟通简洁客观，不需要铺垫和主动建议。

---

## 6. 还欠的账

- 新增的功能代码基本没有单元测试，提交时绕过了覆盖率门禁（浏览器 harness 补了一部分，但不是一回事）
- `world.ts` 有 `window.__world`、`player.ts` 有 `window.__player`、`three-particles-editor.ts` 有 `window.__playerLink`（挂起规则的焦点输入，harness 没法真的让页面失焦）、`window.__videoTextures`（绕过文件对话框）和 `window.__perfHud`，五个调试出口，harness 依赖它们，正式发布前要处理
- 粒子目前不能投射/接收阴影：粒子材质用 `material.vertexNode` 驱动顶点阶段，而阴影 pass 不跑那一段
- 超过 4MB 的全景图存不进 localStorage，当前会话可用但刷新即失
- 只有发射器的内置运动（`simulation.ts`）在两个窗口间对了相位；粒子本身各自独立模拟，永远不会逐帧一致
- 视频在两个窗口里各自播放，相位不对齐（跟粒子一样）；要对齐得把 `currentTime` 塞进快照，还没做
- 本地上传的视频进不了 config（只有名字），换个浏览器就丢；URL 来源的能随 `embeddedVideos` 走。Player 独立成站时视频只能是 URL
- 整个项目没有云端：My Saved Configs、上传的图片和视频、场景、播放页快照全在那台浏览器的 localStorage / IndexedDB 里，换设备就是空白。跨设备只有两条路：Copy/Paste config JSON（图片内嵌、视频走 URL），或者像 WIP-Test-2 那样做成仓库里的 example
- Chrome 会把隐藏 tab 里的静音视频暂停掉，所以显示窗口必须是窗口不能是 tab——这条本来就有，视频让它更硬
- 手机端没验证过。已知边界：WebGPU 要 iOS 27 beta 以上的 WebKit（iPhone 上的 Chrome 也是 WebKit）；两个 tab 只能活一个，显示端靠存储的快照工作（见上）；200k 个 mesh 粒子加 SSR 在手机 GPU 上的帧率要在显示端左上角的计数器里读
- 库的 jest 覆盖率门禁本来就没过（statements 79.0% / 85 分支 83.3%），新加的 sampler 模块自己有 10 条测试，但没把总数拉过线
