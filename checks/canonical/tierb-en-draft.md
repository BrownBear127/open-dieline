<!--
Vendored internal draft
Vendor date: 2026-07-17
-->

# Tier B EN draft

> 2026-07-16 M2 T0：新增附錄 B（B5 匯出句 EN 終稿表·機器可解析形式）供 A15 逐字驗。
> §B5 原表（18 key）為 B1 佔位符正規化前的底稿形式（dotted 佔位符＋行內反引號註解混句），
> 值意未變、僅補終稿形式；原表保留作審閱脈絡，A15 只消費附錄 B。

## B1 參數說明（30）

語調選擇：以名詞短語起頭的 instrument 說明；技術關係與生產用語優先，避免教學口吻。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| rte.param.L.desc | 成品的長邊內尺寸，決定前後兩片面板（P1、P3）的寬度，是整體外觀比例的主要來源。 | Finished long-side inside dimension; sets the width of the front and back panels (P1 and P3) and establishes the box’s overall proportions. | |
| rte.param.W.desc | 成品的短邊內尺寸，決定左右兩片側板（P2、P4）的寬度；同一個數字也決定上下蓋板要多高才能完全蓋住開口——蓋板高＝W。 | Finished short-side inside dimension; sets the width of the left and right side panels (P2 and P4) and the height required for the top and bottom closure panels to cover the opening fully—panel height = W. | |
| rte.param.D.desc | 盒身的高度（開口到底部的距離），決定四片主面板與所有直向摺線的長度。 | Body depth, measured from the opening to the base; sets the length of all four main panels and every vertical crease. | |
| rte.param.thickness.desc | 紙張厚度（caliper）。盒身面板依摺次遞增補償、插舌與讓位間隙隨之調整；設 0 可還原無補償的幾何。 | Board caliper; applies progressive compensation by fold sequence to the body panels and adjusts tuck and relief clearances accordingly. A value of 0 restores uncompensated geometry. | |
| rte.param.tuckDepth.desc | 插舌伸進盒身的深度，決定上蓋抗拉開的力道。 | Tuck insertion depth into the body; determines the top closure’s resistance to pull-out. | |
| rte.param.tuckRadius.desc | 插舌前緣兩個尖角的導圓半徑；設為 0 時插舌會變成直角矩形（前身在此有明確的兩分支：大於 0 走圓弧、等於 0 走直線）。 | Radius applied to the two leading corners of the tuck; a value above 0 draws arcs, while 0 produces a square-cornered rectangular tuck with straight edges. | |
| rte.param.tuckClearance.desc | 插舌左右兩側相對蓋板邊緣往內縮的量，讓插舌略窄於開口寬度，插入時才不會卡死。 | Inset on each side of the tuck from the closure-panel edges; keeps the tuck slightly narrower than the opening to prevent binding during insertion. | |
| rte.param.tuckLock.desc | 蓋板摺線中央摩擦扣凸起的寬度；設為 0 會停用摩擦扣，摺線退化回一條完整直線（無凸起卡榫）。 | Width of the friction-lock projection at the centre of the closure-panel crease; 0 disables the friction lock and restores a continuous straight crease with no locking projection. | |
| rte.param.dustFlapDepth.desc | 左右防塵翼向內摺入的深度，摺入後蓋住開口內側縫隙，阻擋灰塵與透光。 | Inward fold depth of the left and right dust flaps; covers the inner gaps around the opening to block dust and light. | |
| rte.param.flapNotch.desc | 防塵翼根部 J 型避讓槽的開口寬度，切開摺線交會處的應力集中點，避免摺紙時把紙纖維撕裂。 | Opening width of the J-shaped relief notch at the dust-flap root; cuts through the stress concentration at the crease intersection to prevent fibre tear during folding. | |
| rte.param.creaseRelief.desc | 與避讓槽寬取兩者較大值，共同決定避讓槽的實際尺寸——這裡預留材料摺疊時需要的額外間隙（材質愈厚，摺線愈需要避讓空間）。 | Crease relief gap; the greater of this value and the relief-notch width sets the actual notch size, reserving the additional clearance required as board caliper increases. | |
| rte.param.glueSize.desc | 糊邊（耳仔）的寬度，是黏合面板首尾兩端、把展開圖捲成筒狀盒身所需的多餘寬度。 | Glue-flap width; provides the overlap required to join the first and last body panels and form the flat layout into a tube. | |
| rte.param.glueSide.desc | 糊邊黏貼在整排面板的左側或右側（前身 glueOnRight 布林旗標在此改為 enum）；只影響版面鏡像方向，不影響盒子本身結構。 | Glue-flap position on the left or right of the panel run; mirrors the layout without changing the box structure. The former glueOnRight boolean is represented here as an enum. | |
| tel.param.baseLength.desc | 下盒主面板長邊尺寸（製造尺寸，與生產刀模直接對帳）；同時決定上蓋面板長邊（＋2×上蓋放大量）與內襯墊片底面長邊的套合基準（內襯現在錨定下盒內淨，見 linerFitGap）。 | Base main-panel long-side manufacturing dimension, for direct comparison with the production dieline; also sets the lid-panel long side (+ 2× lid oversize) and the fit reference for the liner-pad long side. The liner is anchored to the base inside dimensions; see linerFitGap. | |
| tel.param.baseWidth.desc | 下盒主面板短邊尺寸；同時決定上蓋面板短邊（＋2×上蓋放大量）與內襯墊片底面短邊的套合基準。 | Base main-panel short-side dimension; also sets the lid-panel short side (+ 2× lid oversize) and the fit reference for the liner-pad short side. | |
| tel.param.baseHeight.desc | 下盒後摺壁的名義全高；先摺壁（左右壁）另再減一個壁頂平齊補償量（wallTopCompensation）做「頂緣平齊」修正，讓四片牆摺起後頂緣切齊（Slice 5 F3 解耦：此修正原讀紙厚，現改讀獨立參數）。內襯墊片的腳架深度（linerFlapDepth）不得超過此值，否則內襯會頂出盒口（見 liner-flap-fits 警告）。 | Nominal full height of the base second-fold walls; the first-fold left and right walls are reduced by wallTopCompensation so all four top edges finish flush. As of Slice 5 F3, this correction reads an independent parameter rather than board caliper. Liner leg depth (linerFlapDepth) must not exceed this value or the liner will project above the box opening; see the liner-flap-fits warning. | |
| tel.param.lidMarginX.desc | 上蓋面板短向（對應 baseWidth／x 向先摺壁）相對下盒的等邊放大量——決定上蓋短向能套住下盒多深。Slice 5 F1：原單一 lidMargin 拆兩軸，取消 y 向測試豁免後兩軸皆為可獨立覆蓋的一般參數（無 derivedDefault）。（2026-07-09 T7 gate 重定義：內襯不再錨定上蓋，此參數與內襯幾何無關——見 linerFlapDepth。） | Equal per-side lid oversize on the short axis, corresponding to baseWidth and the x-axis first-fold walls; determines the lid-to-base fit on the short axis. Slice 5 F1 split the former lidMargin into two independently overridable axes with no derivedDefault and removed the y-axis test exemption. Since the 2026-07-09 T7 gate redefinition, the liner is no longer anchored to the lid, so this parameter does not affect liner geometry; see linerFlapDepth. | |
| tel.param.lidMarginY.desc | 上蓋面板長向（對應 baseLength／y 向後摺壁）相對下盒的等邊放大量。與 lidMarginX 各自獨立（Slice 5 F1：生產刀模長短向放大量本不相等 13.5≠18.5，拆分後才能逐線復刻；取消 y 向測試豁免）。 | Equal per-side lid oversize on the long axis, corresponding to baseLength and the y-axis second-fold walls. Independent of lidMarginX: Slice 5 F1 separated the unequal production-dieline oversizes (13.5≠18.5) for line-by-line reproduction and removed the y-axis test exemption. | |
| tel.param.lidHeight.desc | 上蓋後摺壁的名義全高；B-06（Slice 5 F3）：上蓋左右壁的頂緣平齊特例已移除，四面外壁恆等高（不吃 wallTopCompensation，不再有「−1 個紙厚」修正）。 | Nominal full height of the lid second-fold walls. Under B-06 (Slice 5 F3), the flush-top exception for the left and right lid walls has been removed: all four outer walls remain equal in height, do not use wallTopCompensation, and no longer receive the −1 board-caliper correction. | |
| tel.param.basePlatformWidth.desc | 下盒壁頂平台寬度；設 0＝薄壁單線反折（配弧形讓位角撐），大於 0＝厚壁平台（配 45° 斜角撐）。角撐款式跟隨這個值自動切換，不是獨立開關。 | Base wall-top platform width; 0 produces a thin-wall single-line return fold with curved relief gussets, while a value above 0 produces a thick-wall platform with 45° mitred gussets. Gusset style follows this value automatically and is not a separate control. | |
| tel.param.lidPlatformWidth.desc | 上蓋壁頂平台寬度（生產品為薄壁單線反折，預設 0）。設 0 且壁高偏低時，薄壁角撐的讓位槽會擠壓變形，見 gusset-b-fits 警告。 | Lid wall-top platform width; the production form uses a thin-wall single-line return fold, default 0. At 0 with a low wall height, the thin-wall gusset relief can compress and deform; see the gusset-b-fits warning. | |
| tel.param.thickness.desc | 紙張厚度（caliper）。驅動內襯套合間隙（linerFitGap 換算）與角撐對角線位置（reach＝壁高－紙厚）。Slice 5 F3 解耦（audit A-01）：不再直接驅動壁根雙摺線間距與內外壁差，改由 rootJog／innerWallReduction／wallTopCompensation 三個獨立參數負責——設 0 不會讓這三處補償跟著歸零，見各自的參數說明。 | Board caliper; drives the converted liner fit gap (linerFitGap) and gusset diagonal position (reach = wall height − board caliper). Following the Slice 5 F3 decoupling (audit A-01), it no longer drives the wall-root double-crease spacing or the inner-to-outer wall difference directly; rootJog, innerWallReduction, and wallTopCompensation now control those independently. Setting caliper to 0 does not zero those three compensations; see their parameter descriptions. | |
| tel.param.rootJog.desc | 後摺壁（y 向）壁根雙摺線之間的間距——與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。設 0 時雙摺線 collapse 為單一 crease（不論紙厚是否為 0）。Slice 5 T2 起這個位移量會進一步變成壁根階梯 stagger 的 jog 幅度，本階段（T1）幾何形狀仍是現行雙摺線，只有數值來源改讀這個參數。 | Spacing between the double creases at the wall root of the y-axis second-fold walls; an independent parameter decoupled from board caliper in Slice 5 F3 (audit A-01). At 0, the double creases collapse into a single crease regardless of caliper. From Slice 5 T2, this offset also becomes the jog amplitude of the staggered wall root; at the present T1 stage, the geometry remains the current double crease and only the value source changes. | |
| tel.param.innerWallReduction.desc | 牆的內壁（面向盒內、舌摺線起點）相對外壁的縮減量——內壁＝外壁－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀 2×紙厚）。base／lid、x 向／y 向四面牆共用同一個值。 | Reduction of the inner wall, facing the box interior at the tongue-crease origin, relative to the outer wall: inner wall = outer wall − this value. Decoupled from board caliper in Slice 5 F3 (audit A-01; formerly 2× board caliper), this value is shared by all base and lid walls on both the x and y axes. | |
| tel.param.wallTopCompensation.desc | 下盒左右外壁（先摺壁）的頂緣平齊修正量——外壁＝下盒壁高－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。只影響下盒：上蓋左右壁的平齊特例已移除（B-06），四面外壁恆＝壁高，不吃這個補償。 | Flush-top correction for the left and right base outer walls (first-fold walls): outer wall = base wall height − this value. Decoupled from board caliper in Slice 5 F3 (audit A-01), it affects the base only. The lid-wall exception was removed under B-06; all four lid outer walls remain equal to the wall height and do not use this compensation. | |
| tel.param.linerEnabled.desc | 是否產生內襯墊片（2026-07-09 T7 gate 反饋重定義：平台式腳架墊片，放進下盒貼底、把物品墊高）。關閉時只輸出上蓋／下盒兩片，套合與定位需另外自理（如緊配或腰封）。 | Liner-pad generation; under the 2026-07-09 T7 gate redefinition, produces a platform liner seated against the base with downward legs that raise the contents. When disabled, only the lid and base pieces are generated; fit and positioning require a separate solution, such as a friction fit or belly band. | |
| tel.param.linerFitGap.desc | 內襯底面對下盒內淨，四邊各留一次的套合間隙（2026-07-09 T7 gate 重定義：內襯改為平台式、底面錨定下盒內淨，此間隙只扣一次，不再是舊圍框版「上蓋一次＋下盒一次」的雙重扣）；愈大底面愈小、內襯愈鬆好放入。 | Per-side fit gap between the liner base and the base inside dimensions. Under the 2026-07-09 T7 gate redefinition, the platform liner is anchored to the base interior and this gap is deducted once, replacing the former frame liner’s double deduction for lid and base. A larger gap produces a smaller, looser liner that is easier to insert. | |
| tel.param.linerFlapDepth.desc | 內襯四翼向下摺的深度＝腳架高度，也就是物品被墊高的量（2026-07-09 T7 gate 反饋新增：平台式內襯重定義，維護者提供正確形式）。太深會頂出下盒盒口（見 liner-flap-fits 警告），太深也可能讓翼片外緣反轉（同一警告的另一條件）。 | Downward fold depth of the liner’s four flaps = leg height and the amount by which the contents are raised. Added with the 2026-07-09 T7 gate redefinition of the platform liner. Excessive depth can project above the base opening or reverse the flap’s outer edge; see both conditions in the liner-flap-fits warning. | |
| rte.meta.intro | 前後左右四片面板一字排開展開的盒型；上下蓋板各以插舌卡入摩擦扣固定開口，兩側防塵翼摺入遮擋縫隙，免膠帶封口。 | Four front, back, left, and right panels arranged in a single flat run; top and bottom closure panels secure each opening with tucks engaged in friction locks, while the side dust flaps fold inward to cover the gaps. No sealing tape required. | |
| tel.meta.intro | 上蓋與下盒共用同一套免膠雙壁 tray 拓撲、上蓋依長短向分別放大套住下盒（Slice 5 F1：lidMarginX／lidMarginY 兩軸獨立，不再是單一等邊放大量）；內襯墊片放進下盒貼底，四翼向下摺成腳架把物品墊高（2026-07-09 T7 gate 反饋重定義：平台式，取代舊圍框版）。 | Lid and base share the same glueless double-wall tray topology; the lid expands independently along the long and short axes to fit over the base (Slice 5 F1: separate lidMarginX and lidMarginY, replacing a single equal oversize). The liner pad seats against the base with four flaps folded down as legs to raise the contents, following the 2026-07-09 T7 gate redefinition from the former frame liner. | |

## B2 invariant／檢核訊息（24）

語調選擇：簡短、直接的 instrument warning；先陳述預期或故障，再保留必要的幾何結果。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| inv.rte.unfold-width | 展開總寬應為 {expected}mm（含邊距），實際為 {actual}mm | Total unfolded width should be {expected}mm including the margin; actual width is {actual}mm. | |
| inv.rte.lid-equals-w | 蓋板側邊鉛直 cut 線應有 4 條（上蓋 2＋下蓋 2，長度皆＝W={w}mm），實際只找到 {lidSideCuts.length} 條 | Expected 4 vertical cut lines along the closure-panel sides—2 top and 2 bottom, each W={w}mm long; found {lidSideCuts.length}. | |
| inv.rte.tuck-lock-fits.b1 | 摩擦扣寬 {tuckLock}mm 超過蓋板可容納寬度 {lidWidth.toFixed(2)}mm（已計入 girth 補償），會切出面板外 | Friction-lock width {tuckLock}mm exceeds the available closure-panel width of {lidWidth.toFixed(2)}mm after girth compensation and will cut outside the panel. | |
| inv.rte.tuck-lock-fits.b2 | 摩擦扣寬 {tuckLock}mm 小於兩側導角總和 {2 * LOCK_CHAMFER}mm，卡榫梯形會反折自撞 | Friction-lock width {tuckLock}mm is less than the combined side chamfers of {2 * LOCK_CHAMFER}mm; the locking trapezoid will reverse and self-intersect. | |
| inv.rte.tuck-radius-clamped | 插舌圓角 {tuckRadius}mm 超過幾何上限 {limit.toFixed(2)}mm（受插舌深度/寬度限制，已計入 girth 補償），已鉗制繪製 | Tuck radius {tuckRadius}mm exceeds the geometric limit of {limit.toFixed(2)}mm, constrained by tuck depth and width after girth compensation; drawing has been clamped. | |
| inv.rte.no-cut-self-intersection | cut 路徑偵測到自撞（線段真交叉），幾何已退化成無法裁切的翻折形狀 | Cut-path self-intersection detected: line segments cross and the geometry has collapsed into an uncuttable folded form. | |
| inv.tel.liner-flap-fits.b1 | 內襯底面尺寸（{frame.padL.toFixed(2)}×{frame.padW.toFixed(2)}mm）非正值，參數組合下底面幾何不存在 | Liner base dimensions ({frame.padL.toFixed(2)}×{frame.padW.toFixed(2)}mm) are not positive; no base geometry exists for this parameter combination. | |
| inv.tel.liner-flap-fits.b2 | 內襯腳架深度 {linerFlapDepth}mm 超過下盒壁高 {baseHeight}mm，內襯會頂出盒口 | Liner leg depth {linerFlapDepth}mm exceeds the base wall height of {baseHeight}mm; the liner will project above the box opening. | |
| inv.tel.liner-flap-fits.b3 | 內襯腳架深度 {linerFlapDepth}mm 超過底面較短邊長 {minPadEdge.toFixed(2)}mm 的一半，翼片外緣已反轉自撞 | Liner leg depth {linerFlapDepth}mm exceeds half the shorter base edge of {minPadEdge.toFixed(2)}mm; the flap’s outer edge has reversed and self-intersected. | |
| inv.tel.pieces-identity | {label} 主面板實測 {actual.toFixed(2)}mm 應為 {expected.toFixed(2)}mm（pieces 身分可能對調或算錯） | {label} main panel measures {actual.toFixed(2)}mm; expected {expected.toFixed(2)}mm. Piece identities may be swapped or miscalculated. | |
| inv.tel.rim-flush.base | base 片先摺壁外壁高 {baseWalls.x.toFixed(3)}mm 應等於後摺壁 {baseWalls.y.toFixed(3)}mm − 壁頂平齊補償 {wallTopCompensation}mm | Base first-fold outer-wall height {baseWalls.x.toFixed(3)}mm should equal second-fold wall height {baseWalls.y.toFixed(3)}mm − wall-top compensation {wallTopCompensation}mm. | |
| inv.tel.rim-flush.lid | lid 片先摺壁外壁高 {lidWalls.x.toFixed(3)}mm 應等於後摺壁 {lidWalls.y.toFixed(3)}mm（B-06：左右壁特例移除，四面外壁應等高） | Lid first-fold outer-wall height {lidWalls.x.toFixed(3)}mm should equal second-fold wall height {lidWalls.y.toFixed(3)}mm. Under B-06, the left/right-wall exception is removed and all four outer walls should be equal in height. | |
| inv.tel.gusset-b-fits | {platformKey}=0（薄壁角撐）時壁高 {height}mm 低於 {minH.toFixed(1)}mm，讓位槽幾何已擠壓變形 | With {platformKey}=0 (thin-wall gusset), wall height {height}mm is below {minH.toFixed(1)}mm; the relief geometry has compressed and deformed. | |
| inv.tel.tongue-flap-fits | {label}＝{edge}mm 低於插底舌讓位所需的最小邊長 {minEdge}mm，該側插底舌梯形已反轉自撞 | {label}={edge}mm is below the minimum edge length of {minEdge}mm required for the bottom-lock tongue relief; the tongue trapezoid on this side has reversed and self-intersected. | |
| inv.tel.notch-reduced | 側壁雙 U-notch 放不下兩個，已退化為單一置中 notch（notch-reduced） | Two side-wall U-notches do not fit; reduced to one centred notch (notch-reduced). | |
| inv.tel.notch-omitted | U-notch 壁長不足 40mm，已全部省略（notch-omitted） | Wall length is below the 40mm required for a U-notch; all U-notches omitted (notch-omitted). | |
| inv.tel.platform-corner-omitted | 平台端寬度低於 {PLATFORM_CORNER_MIN_WIDTH_MM}mm，角落圓角降級為直角（platform-corner-omitted） | Platform-end width is below {PLATFORM_CORNER_MIN_WIDTH_MM}mm; corner radius reduced to a square corner (platform-corner-omitted). | |
| inv.tel.gusset-relief-omitted | A 款角撐周邊複合 relief 鏈與 U-notch／壁界衝突，或壁高偏離校準值致鏈自身扭曲自撞，已整鏈省略（gusset-relief-omitted） | Type A gusset perimeter relief chain conflicts with a U-notch or wall boundary, or wall height has distorted the chain into self-intersection; entire chain omitted (gusset-relief-omitted). | |
| inv.tel.tongue-crease-shrunk | B 款舌根端段可用長度不足 nominal，已縮減（tongue-crease-shrunk） | Available length at the Type B tongue-root end segment is below nominal; segment shortened (tongue-crease-shrunk). | |
| inv.tel.tongue-crease-omitted | B 款舌根端段可用長度過短，已全省改 halfcut（tongue-crease-omitted） | Available length at the Type B tongue-root end segment is too short; segment omitted and replaced with a half-cut (tongue-crease-omitted). | |
| inv.tel.relief-omitted | V relief 依附端段過短，已省略（relief-omitted） | End segment supporting the V relief is too short; relief omitted (relief-omitted). | |
| inv.common.no-nan | 偵測到 NaN 座標 | NaN coordinate detected. | |
| inv.common.no-bleed | 不應出現 bleed 線型路徑（v1 尚未支援） | Bleed paths should not be present; v1 does not support them. | |
| inv.common.bounds-cover | bounds 未完整涵蓋所有路徑的實際範圍 | Bounds do not fully cover the actual extent of all paths. | |

## B3 modal 段落（8）

語調選擇：克制的 editorial press voice；保留出版聲部與連結錨點，不回添已排除的授權宣稱。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| modal.body.p1 | 一個印刷刀模（dieline）產生器——把包裝盒的結構知識做成可以調參數、可以列印試摺的工具。<br>幾何規則以真實生產刀模逆向量測校準。 | A print-dieline generator—packaging structure made into an instrument whose measures can be adjusted, printed, and folded for trial.<br>Its geometry is calibrated by reverse-measuring production dielines. | 保留原換行。 |
| modal.body.p2 | 目前為開發測試版，僅提供兩種盒型——反向插舌盒（RTE）與天地盒三件套（上蓋／下盒／平台式內襯），更多盒型陸續開發中。 | This is a development build with two box styles: Reverse Tuck End (RTE) and the three-piece Telescope Box—lid, base, and platform liner. More forms are in development. | |
| modal.body.p3 | 本專案是 Konvolut 的一部分——關於書、紙、印刷與收藏的實踐。原始碼在 GitHub，文字刊於 Substack。 | This project is part of Konvolut—a practice concerned with books, paper, print, and collecting. The source is on GitHub; the writing appears on Substack. | Konvolut／GitHub／Substack 保留為連結錨點。 |
| modal.note.1 | ・產出的刀模僅供打樣與學習參考；量產前請務必實際打樣驗證（紙材、絲向、機台都會影響成品） | ・Generated dielines are for prototyping and study only. Always make and verify a physical sample before production; board stock, grain, and machinery all affect the finished piece. | |
| modal.note.2 | ・紙厚補償係數以特定紙材（黑卡 0.4mm 級）的生產經驗校準，其他紙材請自行試摺調整 | ・Board-caliper compensation is calibrated from production experience with a specific stock—approximately 0.4mm black card. Trial-fold and adjust for other stocks. | |
| modal.note.3 | ・所有計算與檔案處理皆在瀏覽器本地完成，匯入的刀模檔不會上傳到任何伺服器 | ・All calculations and file processing take place locally in the browser. Imported dieline files are not uploaded to any server. | |
| modal.note.4 | ・畫布拖曳與校準以滑鼠操作設計，建議使用桌面瀏覽器 | ・Canvas dragging and calibration are designed for mouse input. A desktop browser is recommended. | |
| modal.note.5 | ・非商業使用授權（PolyForm Noncommercial 1.0.0）；商業使用及問題回報請聯繫：hello@konvolut.art | ・Licensed for noncommercial use under PolyForm Noncommercial 1.0.0. For commercial use or issue reports, contact hello@konvolut.art. | |

## B4 說明長句（2）

語調選擇：精簡的 instrument help text；直接交代用途、範圍與例外。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| layers.overlays.desc | 對照調參用——匯入生產刀模、校準比例後與生成層疊圖比對（特別是 R 角與細部結構）。 | For reference while adjusting parameters—import a production dieline, calibrate its scale, and overlay it against the generated layer, especially at radiused corners and fine details. | |
| export.manufacturing.title | 僅影響 SVG 匯出：solid／0.25 線寬／round cap-join，排除尺寸標註與文字（DXF 恆排除標註，不受此開關影響） | SVG export only: solid strokes, 0.25 stroke width, and round caps and joins; dimensions and text excluded. DXF always excludes annotations and is unaffected by this control. | |

## B5 拼版句（18）

語調選擇：結果讀數採自然、緊湊的 imposition 語序；DISCLAIMER 明確界定估算範圍與不可直接生產。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| imp.disclaimer | 以單件輪廓間距估算（單向收縮）；未計交錯、塞角、共刀、絲向及加工限制，不可直接作生產拼版。 | Estimate based on spacing between individual-piece outlines, with one-way contraction. Does not account for interlocking, corner filling, common-line cutting, grain, or processing constraints. Not suitable for direct production imposition. | |
| imp.sheet.working | 工作尺寸：{sheet.w.toFixed(1)} × {sheet.h.toFixed(1)} mm（可用區 {sheet.usableW.toFixed(1)} × {sheet.usableH.toFixed(1)} mm） | Working size: {sheet.w.toFixed(1)} × {sheet.h.toFixed(1)} mm (usable area {sheet.usableW.toFixed(1)} × {sheet.usableH.toFixed(1)} mm) | |
| imp.sub.quarter | 四開子紙 | Quarter-sheet section | |
| imp.sub.half | 半張子紙 | Half-sheet section | |
| imp.sheet.workingCut | 全紙 {sheet.fullW.toFixed(1)} × {sheet.fullH.toFixed(1)} mm，{subLabel} {sub}（`sub` = {sheet.w.toFixed(1)} × {sheet.h.toFixed(1)} mm（可用 {sheet.usableW.toFixed(1)} × {sheet.usableH.toFixed(1)} mm）） | Full sheet {sheet.fullW.toFixed(1)} × {sheet.fullH.toFixed(1)} mm; {subLabel} {sub} (`sub` = {sheet.w.toFixed(1)} × {sheet.h.toFixed(1)} mm (usable {sheet.usableW.toFixed(1)} × {sheet.usableH.toFixed(1)} mm)) | `sub` 組字結構照原底稿保留。 |
| imp.per.quarter | 每四開 | per quarter-sheet section | 完整組句重排為 `{count} up per quarter-sheet section × {sectionsCount} sections = {totalCount} up`。 |
| imp.per.half | 每半張 | per half-sheet section | 完整組句重排為 `{count} up per half-sheet section × {sectionsCount} sections = {totalCount} up`。 |
| imp.grid.formula | {direction.cols} 列 × {direction.rows} 行{fillSuffix} ＝ {direction.count} 模（`fillSuffix` = ＋ 補 {fillCount}） | {direction.cols} columns × {direction.rows} rows{fillSuffix} = {direction.count} up (`fillSuffix` = + {fillCount} additional up) | `fillSuffix` 組字結構照原底稿保留。 |
| imp.spacing.rows | 行距輪廓收縮 | Row-spacing outline contraction | |
| imp.spacing.cols | 列距輪廓收縮 | Column-spacing outline contraction | |
| imp.footprint | 主格點 footprint {direction.usedW.toFixed(1)} × {direction.usedH.toFixed(1)} mm | Primary-grid footprint {direction.usedW.toFixed(1)} × {direction.usedH.toFixed(1)} mm | |
| imp.err.internal | 系統內部計算錯誤，請重新整理頁面；若持續發生請回報。 | Internal calculation error. Reload the page; report the issue if it persists. | |
| imp.err.default | 計算發生錯誤，請確認輸入數值。 | Calculation error. Check the input values. | |
| imp.err.field.notFinite | 請輸入有效數字 | Enter a valid number. | |
| imp.err.field.notPositive | 必須大於 0 | Must be greater than 0. | |
| imp.err.field.belowMin | 不得小於 {MIN_GAP_MM}mm | Must not be less than {MIN_GAP_MM}mm. | |
| imp.err.field.outOfRange | 數值超出安全範圍 | Value is outside the safe range. | |
| imp.err.field.internal | 內部計算錯誤 | Internal calculation error. | |

## B6 overlay 警告（8）

語調選擇：簡潔的 parser warning；保留 tag、函式名、計數與原生例外內容。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| ovl.warn.notImported | {key} ×{n} 未匯入 | {key} ×{n} not imported | `{key}` 的 tag 或警告 key 值不翻。 |
| ovl.warn.pathIncomplete | path 資料不完整，部分內容 | path data incomplete; partial content | 作為 `{key}` 值使用。 |
| ovl.warn.rectRadius | rect 圓角（rx/ry） | rect corner radius (rx/ry) | 作為 `{key}` 值使用。 |
| ovl.warn.transform | transform {name} 不支援，已忽略 ×{n} | transform {name} is unsupported; ignored ×{n} | `{name}` 函式名不翻。 |
| ovl.warn.droppedSegments | {dropped} 個線段座標無法解析，已略過 | {dropped} segment coordinates could not be parsed and were skipped | |
| ovl.warn.classStyle | {classStyleCount} 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入） | {classStyleCount} elements contain class/style rules; styles were not applied and all elements were imported as cut lines | |
| ovl.warn.parseFail | SVG 解析失敗：不是合法的 SVG 文件 | SVG parsing failed: not a valid SVG document | |
| ovl.warn.parseFailMsg | SVG 解析失敗：{msg} | SVG parsing failed: {msg} | `{msg}` 原生例外訊息透傳不翻。 |

## B7 pieces 檢核（9）

語調選擇：error-code 前綴後接精確、簡短的 instrument diagnosis；所有 debug 錨點逐字保留。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| inv.pieces.duplicate-piece-id | duplicate-piece-id: 片 id「{piece.id}」重複出現 | duplicate-piece-id: piece id “{piece.id}” appears more than once | |
| inv.pieces.empty-piece | empty-piece: 片「{piece.id}」沒有任何 path/text 成員 | empty-piece: piece “{piece.id}” has no path/text members | |
| inv.pieces.unknown-id | unknown-{kind}-id: 片「{piece.id}」引用了不存在的 {kind} id「{id}」 | unknown-{kind}-id: piece “{piece.id}” references nonexistent {kind} id “{id}” | |
| inv.pieces.double-assigned | double-assigned-{kind}: {kind} id「{id}」同時被「{owner}」與「{piece.id}」兩片認領 | double-assigned-{kind}: {kind} id “{id}” is assigned to both “{owner}” and “{piece.id}” | |
| inv.pieces.unassigned | unassigned-{kind}: {kind} id「{id}」未被任何片認領 | unassigned-{kind}: {kind} id “{id}” is not assigned to any piece | |
| inv.pieces.piece-bounds-mismatch | piece-bounds-mismatch: 片「{piece.id}」的 bounds 未涵蓋其成員的實際範圍 | piece-bounds-mismatch: bounds for piece “{piece.id}” do not cover the actual extent of its members | |
| inv.pieces.overlapping-pieces | overlapping-pieces: 片「{a.id}」與「{b.id}」的 bounds 重疊 | overlapping-pieces: bounds for pieces “{a.id}” and “{b.id}” overlap | |
| inv.pieces.result-bounds-mismatch | result-bounds-mismatch: GenerateResult.bounds 與全片 bounds 聯集包絡不一致 | result-bounds-mismatch: GenerateResult.bounds does not match the union hull of all piece bounds | |
| inv.pieces.geometry-hull-mismatch | geometry-hull-mismatch: GenerateResult.bounds 與全幾何包絡不一致（宣告的 bounds 跟實際幾何脫節） | geometry-hull-mismatch: GenerateResult.bounds does not match the full geometry hull; declared bounds are detached from the actual geometry | |

---

## B8 摺盒模式狀態文案（3·P3 M1 新增·2026-07-17 簽核）

語調：儀器陳述式（同 B2 家族）；mono 聲部置中；無 audit 前身。

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| fold.unsupported | 此盒型尚未支援 3D 摺盒預覽。 | 3D fold preview is not yet available for this box style. | |
| fold.webglUnavailable | 瀏覽器不支援 WebGL，無法顯示 3D 摺盒預覽。 | 3D fold preview requires WebGL, which is not available in this browser. | |
| fold.loadFailed | 3D 摺盒預覽載入失敗，切換模式可重試。 | 3D fold preview failed to load. Switch modes to retry. | |

---

## B9 摺盒卡色短件（4·P3 M2 新增·2026-07-17 實作輪 提案·待 B5-final 追認）

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| fold.card.label | 卡色 | CARD | production 三態切換標籤。 |
| fold.card.white | 白 | WHITE | production 配方名。 |
| fold.card.kraft | 牛皮 | KRAFT | production 配方名。 |
| fold.card.black | 黑 | BLACK | production 配方名。 |

---

## B10 摺盒圖稿短件（3·P3 M2 T2.6 新增·2026-07-17 實作輪 提案·待 B5-final 追認）

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| fold.art.label | 圖稿 | ART | production 二態切換標籤。 |
| fold.art.none | 無 | NONE | 素面紙張。 |
| fold.art.sample | 範例 | SAMPLE | 內建程序化範例稿。 |

## B11 設計稿上傳（4·P3 M3 T0 新增·2026-07-17 review 草案＋採納·待 C9 簽核輪終裁）

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| fold.art.template | 模板 | TEMPLATE | 對位模板下載鈕。 |
| fold.art.upload | 上傳 | UPLOAD | 設計稿傳回鈕（toggle）。 |
| fold.art.staleTemplate | 參數已變更，建議重新下載模板對位。 | Parameters changed. Download a new template to realign your artwork. | stale overlay·role=status。 |
| fold.art.invalidFile | 無法使用此檔案。請上傳大小限制內的 PNG、JPEG 或 SVG。 | This file can’t be used. Upload a PNG, JPEG, or SVG within the size limit. | error overlay·role=alert。 |

## B12 套圖編輯器（24·P3 M4 T4 新增·2026-07-18 簽核終稿）

| key | zh（照抄·對照用） | EN（英文稿） | 譯註（僅必要時） |
|---|---|---|---|
| fold.art.edit | 編輯 | EDIT | 圖稿編輯入口。 |
| editor.done | 完成 | DONE | 編輯器返回預覽。 |
| editor.addImage | 加圖 | IMAGE | 圖片物件。 |
| editor.addText | 加字 | TEXT | 文字物件。 |
| editor.duplicate | 複製 | COPY | 複製選取物件。 |
| editor.delete | 刪除 | DELETE | 刪除選取物件。 |
| editor.layerUp | 上移 | RAISE | 圖層上移一層。 |
| editor.layerDown | 下移 | LOWER | 圖層下移一層。 |
| editor.download | 下載成品 | ARTWORK PNG | 成品 PNG 下載。 |
| editor.empty | 加入圖片或文字開始編輯。 | Add an image or text to begin. | 空畫布狀態。 |
| editor.stale | 參數已變更，請重新對位物件。 | Parameters changed. Reposition your artwork to realign. | 對位過期狀態。 |
| editor.limit.objects | 已達物件上限（32）。 | Object limit reached (32). | 物件上限狀態。 |
| editor.error.compose | 合成失敗，請重試或移除最後加入的物件。 | Rendering failed. Try again or remove the last object. | 合成錯誤狀態。 |
| editor.font.sans | 無襯線 | SANS | 系統 sans 字族。 |
| editor.font.serif | 襯線 | SERIF | 系統 serif 字族。 |
| editor.font.mono | 等寬 | MONO | 系統 mono 字族。 |
| editor.align.left | 左 | LEFT | 文字左對齊。 |
| editor.align.center | 中 | CENTER | 文字置中。 |
| editor.align.right | 右 | RIGHT | 文字右對齊。 |
| editor.color.ink | 墨 | INK | InkPaletteColor `ink`。 |
| editor.color.inkSoft | 淡墨 | SOFT | InkPaletteColor `inkSoft`。 |
| editor.color.cut | 刀紅 | CUT | InkPaletteColor `cut`。 |
| editor.color.crease | 摺藍 | CREASE | InkPaletteColor `crease`。 |
| editor.color.brass | 黃銅 | BRASS | InkPaletteColor `brass`。 |

---

## 複核記錄（2026-07-16）

全稿採納（99/99·零駁回）。檢核項：D7 禁詞零違規／模板變數逐字保留（含運算式形）／
詞彙錨與 Tier A §A 一致／B3 editorial 腔＋B2/B7 儀器腔到位／error-code 前綴逐字。
整合修正：①正式計數=99（B1=30：RTE 13 參數+tel 15+intro 2——expansion 摘要與 audit
prose 的「12 參數」皆誤·實列 13）②imp.per.* 的 EN 重排 → M1 實作契約=message-template
i18n（整句 key＋具名參數·禁字串拼接·記 inventory §D）。
狀態：待抽查 → 凍結為文案終稿。

## 附錄 A — inv.tel.tongue-flap-fits 的 {label} EN 值（2026-07-16 裁決·M1 final-copy）

zh label 不動；EN label 用「left/right・front/back」牆命名（選項 A·語料相容 rim-flush 的 left/right-wall 前例）。
{label} 承載在 telescope/index.ts checks 陣列（LocalizedText 家族·不進 dict）：

| zh label（原字串·不動） | EN label（裁決值·逐字） |
|---|---|
| base 片左右壁的插底舌所在邊 baseLength | Tongue edge of the base left/right walls, baseLength |
| base 片前後壁的插底舌所在邊 baseWidth | Tongue edge of the base front/back walls, baseWidth |
| lid 片左右壁的插底舌所在邊 baseLength＋2×lidMarginY | Tongue edge of the lid left/right walls, baseLength+2×lidMarginY |
| lid 片前後壁的插底舌所在邊 baseWidth＋2×lidMarginX | Tongue edge of the lid front/back walls, baseWidth+2×lidMarginX |

（此前過渡態＝純參數式 label；本附錄取代之。pieces-identity 的 enLabel 維持量測識別子 base.x/lid.y 家族·非本附錄範疇。）

## 附錄 B——B5 匯出句 EN 終稿表（2026-07-16 M2 T0·A15 逐字消費）

§B5 原表不可機器逐字比對（佔位符形式過時），本表為 B5 全 20 key 的 EN 終稿：
值＝`src/i18n/dict.ts` 現值逐字（B1 已正規化·句面文字未變）。**每值以反引號包覆**
（機器解析剝殼·殼內逐字，含前導／尾隨空白——如 `imp.grid.fillSuffix` 的前導空白）。
zh 終稿＝inventory-expansion §B5「zh（逐字／模板）」欄，本表不重複。

| key | EN（終稿·dict 逐字） |
|---|---|
| imp.disclaimer | `Estimate based on spacing between individual-piece outlines, with one-way contraction. Does not account for interlocking, corner filling, common-line cutting, grain, or processing constraints. Not suitable for direct production imposition.` |
| imp.sheet.working | `Working size: {sheetW} × {sheetH} mm (usable area {sheetUsableW} × {sheetUsableH} mm)` |
| imp.sub.quarter | `Quarter-sheet section` |
| imp.sub.half | `Half-sheet section` |
| imp.sheet.workingCut | `Full sheet {sheetFullW} × {sheetFullH} mm; {subLabel} {sub}` |
| imp.sheet.subSize | `{sheetW} × {sheetH} mm (usable {sheetUsableW} × {sheetUsableH} mm)` |
| imp.per.quarter | `per quarter-sheet section` |
| imp.per.half | `per half-sheet section` |
| imp.grid.formula | `{cols} columns × {rows} rows{fillSuffix} = {count} up` |
| imp.grid.fillSuffix | ` + {fillCount} additional up` |
| imp.spacing.rows | `Row-spacing outline contraction` |
| imp.spacing.cols | `Column-spacing outline contraction` |
| imp.footprint | `Primary-grid footprint {usedW} × {usedH} mm` |
| imp.err.internal | `Internal calculation error. Reload the page; report the issue if it persists.` |
| imp.err.default | `Calculation error. Check the input values.` |
| imp.err.field.notFinite | `Enter a valid number.` |
| imp.err.field.notPositive | `Must be greater than 0.` |
| imp.err.field.belowMin | `Must not be less than {MIN_GAP_MM}mm.` |
| imp.err.field.outOfRange | `Value is outside the safe range.` |
| imp.err.field.internal | `Internal calculation error.` |
