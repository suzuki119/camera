// =============================================================
//  指鉄砲バトル（p5.js + ml5.js）
//
//  ■ 遊び方
//    1. 2人でカメラに映る。画面の左半分が P1（赤）、右半分が P2（青）
//    2. 親指と人差し指を立てて L字にすると「構え」（骨格が黄色になる）
//    3. そのまま親指を倒すと、人差し指の先から弾が出る
//    4. 相手の手に当たると HP が 20 減り、0 になった方が負け
//    5. 決着したら画面をクリックで再戦
//
//  ■ 3つの役割分担
//    ml5.js     … 映像から「手の21点の座標」を出す（検出の担当）
//    このファイル … 座標から意味を読み取る（構え？発射？当たった？）
//    p5.js      … カメラの起動、毎フレームの呼び出し、画面への描画
//
//  ■ 2つのループが別々に動いている
//    描画ループ：p5.js が draw() を画面の更新ごとに呼ぶ（約60回/秒）
//    検出ループ：ml5.js が検出を終えるたびに gotHands() を呼ぶ（PCの性能しだい）
//    この2つは、下のグローバル変数を通してデータをやり取りする
// =============================================================


// -------------------------------------------------------------
//  調整できる数値
// -------------------------------------------------------------

// 手の形の判定のゆるさ（数値を大きくするほどゆるい＝判定されやすい）
const INDEX_BEND = 90;       // 人差し指の曲がりの許容（度）。これ以下なら「伸びている」
const THUMB_BEND = 120;      // 親指の曲がりの許容（度）
const GUN_ANGLE = [30, 160]; // 構えとみなす、親指と人差し指の間の角度（度）
const THUMB_IN = 0.9;        // 親指を倒したとみなす距離。手のひらの長さに対する割合
const DISARM_GRACE = 500;    // 形が崩れても構えを保つ時間（ms）。検出の一瞬のぶれ対策

// 対戦のルール
const MAX_HP = 100;
const DAMAGE = 20;           // 1発のダメージ（100 ÷ 20 で5発で倒れる）
const HIT_PAD = 20;          // 手の当たり判定を広げる量（映像のピクセル）
const COOLDOWN = 250;        // 次に撃てるまでの時間（ms）。二重発射の防止
const COLORS = ['#FF4D4D', '#4DA6FF'];   // [P1 の赤, P2 の青]


// -------------------------------------------------------------
//  グローバル変数（2つのループが共有するデータ）
// -------------------------------------------------------------

let video;      // p5.js のカメラ映像（p5.Element）
let handPose;   // ml5.js の手の検出モデル

// 今フレームで見えている手。gotHands() が書き込み、draw() が読む
//   { h: ml5 の検出結果, side: 0 = P1 / 1 = P2 }
let hands = [];

let players;    // プレイヤー2人の状態（HP、構え中かなど）
let bullets;    // 飛んでいる弾
let effects;    // 発射の光や被弾の演出
let winner;     // 勝者の文字列。決着前は null


// =============================================================
//  1. 準備（p5.js が決まった順番で呼ぶ関数）
// =============================================================

// preload() は p5.js が最初に1回だけ呼ぶ。
// ここで始めた読み込みが終わるまで、p5.js は setup() を待ってくれる。
// ml5.js はこの仕組みに対応しているので、待つコードを書かなくてよい。
//
// ※ p5.js 2.x では preload() が廃止されたため、index.html では 1.x を読み込んでいる
function preload() {
    // maxHands: 2  → 同時に検出する手は最大2本（対戦相手と自分）
    // flipped: true → 左右反転した映像で検出する。下の createCapture の反転と揃える必要がある
    //                 （揃っていないと、骨格が手からずれて表示される）
    handPose = ml5.handPose({ maxHands: 2, flipped: true });
}

// setup() は preload() の後に1回だけ呼ばれる
function setup() {
    createCanvas(windowWidth, windowHeight);
    angleMode(DEGREES);   // 角度を「度」で扱う（指定しないとラジアン）
    textStyle(BOLD);

    // カメラを起動する。第1引数は getUserMedia にそのまま渡される設定
    // flipped: true で、image() で描くときに鏡のように左右反転される
    video = createCapture({ video: { width: 1280, height: 720 }, audio: false }, { flipped: true });
    video.hide();   // p5.js が自動で作る <video> 要素は隠す（描画は image() で行うため）

    // 検出を開始する。以降、結果が出るたびに gotHands() が呼ばれ続ける
    handPose.detectStart(video, gotHands);

    resetGame();
}

// ウィンドウの大きさが変わったら、キャンバスも合わせる（p5.js が自動で呼ぶ）
function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// クリックされたら（p5.js が自動で呼ぶ）。決着後のみ再戦
function mousePressed() { if (winner) resetGame(); }

function resetGame() {
    players = [0, 1].map(() => ({
        hp: MAX_HP,
        armed: false,    // 構え中か
        lastShot: 0,     // 最後に撃った時刻（ms）。連射の防止に使う
        lastGrip: 0,     // 最後に銃の形だった時刻（ms）。構えの解除の判断に使う
    }));
    bullets = [];
    effects = [];
    winner = null;
}


// =============================================================
//  2. 手の形の判定
// =============================================================

// 手の21点の座標から、今どんな形かを判定する。
//
// ■ keypoints3D を使う理由
//   ml5.js は2種類の座標をくれる。
//     keypoints   … 映像のピクセル座標（2D）。描画や当たり判定に使う
//     keypoints3D … メートル単位の3D座標。原点は手のおおよその中心
//   3D座標は、カメラからの距離や手の向きに左右されにくいので、形の判定に向いている。
//
// ■ 21点の番号（親指=1〜4、人差し指=5〜8、中指=9〜12、薬指=13〜16、小指=17〜20）
//         8  12  16  20   ← 指先（tip）
//         7  11  15  19   ← 第1関節（dip）
//   4     6  10  14  18   ← 第2関節（pip）
//   3     5   9  13  17   ← 付け根（mcp）
//   2
//   1          0          ← 手首（wrist）
//
// 戻り値
//   grip   … 銃のグリップの形（人差し指が立ち、他の指が折れている）
//   gun    … L字の構え（グリップ＋親指が開いている）
//   hammer … 引き金を引いた形（人差し指は立てたまま、親指を倒した）
function judgePose(h) {
    // 21点を p5.Vector の配列にする。p[8] のように番号で取り出せる
    const p = h.keypoints3D.map(k => createVector(k.x, k.y, k.z));

    // --- 計算を短く書くための小さな関数 ---

    // 2点間の距離。引数は点の番号（例：d(0, 9) は手首から中指の付け根まで）
    const d = (from, to) => p5.Vector.dist(p[from], p[to]);

    // 「点1→点2 の向き」と「点3→点4 の向き」がなす角（度）
    // 例：ang(2, 4, 5, 8) は、親指の向きと人差し指の向きの角度
    //
    // ⚠️ p5.js の angleBetween() は、3Dのベクトルだと外積の向きでマイナスの値を返す。
    //    符号は手の向き（右を指すか左を指すか）で変わるため、絶対値を取らないと
    //    片方の向きだけ判定に失敗する（実際にこのバグで、青側だけ撃てなかった）
    const ang = (p1, p2, p3, p4) => abs(p5.Vector.sub(p[p2], p[p1]).angleBetween(p5.Vector.sub(p[p4], p[p3])));

    // 第2関節（pip）での曲がり具合（度）。0°ならまっすぐ、90°なら直角に曲がっている
    // 「付け根→第2関節」と「第2関節→指先」の向きのズレを見ている
    const bend = (mcp, pip, tip) => ang(mcp, pip, pip, tip);

    // 指が折れているか。指先が第2関節と同じくらいか、より手首に近ければ折れている
    // （指を曲げると、指先は手のひら側に戻ってきて手首に近づく）
    const folded = (pip, tip) => d(tip, 0) < d(pip, 0) * 1.15;

    // --- ここから実際の判定 ---

    // 手のひらの長さ（手首→中指の付け根）。これを「1」として他の距離を測る。
    // 手の大きさやカメラからの距離が違っても、同じ基準で判定するための工夫
    const palm = d(0, 9);

    // 人差し指が立っているか：曲がりが小さく、かつ指先が第2関節より手首から遠い
    const indexUp = bend(5, 6, 8) < INDEX_BEND && d(8, 0) > d(6, 0);

    // 銃のグリップ：人差し指が立ち、中指・薬指・小指が3本中2本以上折れている
    // （3本すべてを求めると厳しすぎるので、2本で判定をゆるくしている）
    const grip = indexUp && [folded(10, 12), folded(14, 16), folded(18, 20)].filter(Boolean).length >= 2;

    // 親指の向き（2→4）と人差し指の向き（5→8）のなす角。L字なら90°前後になる
    const thumbAngle = ang(2, 4, 5, 8);

    // 親指の先が、人差し指の付け根・第2関節のどちらか近い方までの距離
    const thumbTip = min(d(4, 5), d(4, 6));

    // 親指が開いているか：親指がまっすぐで、人差し指から十分離れている
    const thumbOut = bend(2, 3, 4) < THUMB_BEND && thumbTip > palm * 0.4;

    // 親指が倒れているか：人差し指に近い、または角度がほとんど無い
    const thumbIn = thumbTip < palm * THUMB_IN || thumbAngle < GUN_ANGLE[0];

    // 構え（L字）の完成形
    const gun = grip && thumbOut && thumbAngle > GUN_ANGLE[0] && thumbAngle < GUN_ANGLE[1];

    // 発射の形。人差し指さえ立っていればよい（撃つ瞬間に他の指が動いてもいいように）
    // 「!gun」を付けて、構えと発射が同時に成立しないようにしている
    return { grip, gun, hammer: indexUp && thumbIn && !gun };
}


// =============================================================
//  3. 検出結果を受け取る（構え → 発射の状態遷移）
// =============================================================

// ml5.js が検出を終えるたびに呼ばれる。draw() とは別のタイミングで動く。
// results は、検出された手ごとのオブジェクトの配列。
//
// ■ 状態の変化
//                gun（L字の構え）
//     ┌──────┐ ─────────────▶ ┌──────┐
//     │ 待機 │                │ 構え │
//     └──────┘ ◀───────────── └──────┘
//        ▲      形が0.5秒崩れた    │ hammer（親指を倒した）
//        │                         ▼
//        └───────────────── 発射！（弾を作って待機に戻る）
//
// 撃つと必ず待機に戻るので、親指を倒したままでは連射できない。
// もう一度構え直す必要がある。
function gotHands(results) {
    const now = millis();   // プログラム開始からの経過時間（ms）
    hands = [];

    for (const h of results) {
        // どちらのプレイヤーの手か、手の位置で決める。
        // 映像は反転済みなので、座標がそのまま画面の見た目と一致する
        const side = h.middle_finger_mcp.x < video.elt.videoWidth / 2 ? 0 : 1;

        // 同じ側で2本目の手は無視する（1人1本の手で遊ぶため）
        if (hands.some(v => v.side === side)) continue;
        hands.push({ h, side });   // draw() がこれを見て骨格を描く

        const s = players[side];
        const pose = judgePose(h);

        // 銃の形だった時刻を覚えておく（構えを解除するか判断するため）
        if (pose.grip || pose.gun) s.lastGrip = now;

        if (pose.gun) {
            // 構えた
            s.armed = true;
        } else if (s.armed && pose.hammer && now - s.lastShot > COOLDOWN) {
            // 構えている状態から親指を倒した → 発射
            if (!winner) fire(h, side);
            s.armed = false;
            s.lastShot = now;
        } else if (now - s.lastGrip > DISARM_GRACE) {
            // 銃の形がしばらく崩れていたら、構えを解除する。
            // すぐに解除しないのは、検出が一瞬ぶれただけで構えが消えるのを防ぐため
            s.armed = false;
        }
    }

    // 手が画面から消えた場合も、少しの間は構えを保つ
    players.forEach((s, i) => {
        if (!hands.some(v => v.side === i) && now - s.lastGrip > DISARM_GRACE) s.armed = false;
    });
}


// =============================================================
//  4. ゲームの処理（発射・ダメージ・当たり判定）
// =============================================================

// 弾を1発作る。座標は映像のピクセル座標（keypoints の方）を使う
function fire(h, owner) {
    // 弾の出る位置は人差し指の先
    const pos = createVector(h.index_finger_tip.x, h.index_finger_tip.y);

    // 飛ぶ向きは「人差し指の付け根 → 指先」。指の指す方向になる
    // p5.Vector.sub(a, b) は a - b を新しいベクトルとして返す（a と b は変わらない）
    const vel = p5.Vector.sub(pos, createVector(h.index_finger_mcp.x, h.index_finger_mcp.y));

    // 指を真正面（カメラ方向）に向けると、画面上の長さが 0 になることがある。その場合は上向きにする
    if (vel.mag() === 0) vel.set(0, -1);

    // 向きはそのままで、長さ（＝速さ）を設定する。単位はピクセル/秒。
    // 映像の幅に比例させているので、カメラの解像度が変わっても見た目の速さは同じ
    vel.setMag(video.elt.videoWidth * 2.4);

    bullets.push({ pos, vel, owner });
    effects.push({ type: 'flash', pos: pos.copy(), t: millis() });   // 銃口の光
}

// ダメージを与える
function damage(side, pos) {
    const pl = players[side];
    pl.hp = max(0, pl.hp - DAMAGE);      // マイナスにならないように max で止める
    effects.push({ type: 'hit', pos: pos.copy(), t: millis() });
    // side が 0（P1）なら勝者は P2、1（P2）なら P1 になる
    if (pl.hp === 0) winner = `P${2 - side} の勝ち！`;
}

// 弾が手に当たったか。
// 手の21点を囲む四角形を HIT_PAD だけ広げ、その中に弾があれば命中とする。
// 「バウンディングボックス（外接矩形）」と呼ばれる、一番単純な当たり判定
function inHand(h, pos) {
    const xs = h.keypoints.map(k => k.x), ys = h.keypoints.map(k => k.y);
    return pos.x > min(xs) - HIT_PAD && pos.x < max(xs) + HIT_PAD &&
        pos.y > min(ys) - HIT_PAD && pos.y < max(ys) + HIT_PAD;
}


// =============================================================
//  5. 描画
// =============================================================

// 黒い縁取りのついた文字を描く（映像の上でも読めるように）
function label(txt, x, y, c) {
    textSize(32);
    textAlign(CENTER, BASELINE);
    stroke(0);          // 縁取りの色
    strokeWeight(5);    // 縁取りの太さ
    fill(c);            // 文字の色
    text(txt, x, y);
}

// p5.js が画面の更新ごとに呼ぶ（約60回/秒）
function draw() {
    background(0);

    // video.elt は、p5.js が包んでいる元の <video> 要素。
    // videoWidth はカメラの実際の解像度で、準備ができるまでは 0
    const vw = video.elt.videoWidth, vh = video.elt.videoHeight;
    if (!vw) return;   // カメラの準備待ち（0 で割ると Infinity になってしまう）

    // ■ 座標系を映像に合わせる
    //   ml5.js がくれる座標は「映像のピクセル」（例：1280×720）。
    //   一方キャンバスはウィンドウの大きさ。そのまま描くと位置がずれる。
    //   そこで原点と倍率を変えて、以降は映像の座標のまま描けるようにする。
    //   拡大率に max を使うと、縦横比を保ったままウィンドウを隙間なく覆える（はみ出た部分は切れる）
    const s = max(width / vw, height / vh);
    push();                                                    // 今の座標系を保存
    translate((width - vw * s) / 2, (height - vh * s) / 2);    // 中央に寄せる
    scale(s);                                                  // 以降の描画をすべて s 倍
    image(video, 0, 0, vw, vh);                                // カメラ映像

    // --- 陣地の境界線 ---
    stroke(255, 100);   // 白・透明度100（0〜255）
    strokeWeight(2);
    // p5.js に点線の機能は無いので、Canvas 2D API を直接呼ぶ。
    // drawingContext は p5.js が内部で使っているコンテキストそのもの
    drawingContext.setLineDash([10, 10]);
    line(vw / 2, 0, vw / 2, vh);
    drawingContext.setLineDash([]);   // 元に戻す（以降の線が点線になるのを防ぐ）

    // --- 手の骨格（構え中は黄色） ---
    for (const { h, side } of hands) {
        const armed = players[side].armed;
        stroke(armed ? '#FFD600' : COLORS[side]);
        strokeWeight(3);
        // getConnections() は、繋ぐべき点の組（[[0,1], [1,2], ...]）をくれる
        for (const [from, to] of handPose.getConnections()) {
            line(h.keypoints[from].x, h.keypoints[from].y, h.keypoints[to].x, h.keypoints[to].y);
        }
        noStroke();
        fill(COLORS[side]);
        for (const k of h.keypoints) circle(k.x, k.y, 6);   // 関節の点
        if (armed) label('構え', h.wrist.x, h.wrist.y + 40, '#FFD600');
    }

    // --- 弾（尾を引いて飛び、相手の手に当たるか画面外に出たら消える） ---
    for (const b of bullets) {
        // 「速度 × 経過時間」で動かす。deltaTime は前のフレームからの経過時間（ms）。
        // 1フレームあたり何ピクセル、にすると、PCの速さで弾の速度が変わってしまう
        b.pos.add(p5.Vector.mult(b.vel, deltaTime / 1000));

        // 相手の手に当たったか（自分の手はそもそも探す対象に入れない）
        const target = !winner && hands.find(v => v.side !== b.owner && inHand(v.h, b.pos));
        if (target) {
            damage(target.side, b.pos);
            b.dead = true;     // ここでは印を付けるだけ
            continue;
        }
        // 画面の外に出た
        if (b.pos.x < -50 || b.pos.y < -50 || b.pos.x > vw + 50 || b.pos.y > vh + 50) {
            b.dead = true;
            continue;
        }

        // 弾の尾（0.05秒前にいた位置まで線を引く）と、弾本体
        stroke(COLORS[b.owner]);
        strokeWeight(4);
        line(b.pos.x, b.pos.y, b.pos.x - b.vel.x * 0.05, b.pos.y - b.vel.y * 0.05);
        noStroke();
        fill('#FFF3B0');
        circle(b.pos.x, b.pos.y, 12);
    }
    // 消える弾は、ループの中ではなく後からまとめて取り除く。
    // ループ中に配列から直接消すと、次の要素を読み飛ばしてしまうため
    bullets = bullets.filter(b => !b.dead);

    // --- エフェクト（銃口の光は150ms、被弾は400msで消える） ---
    for (const e of effects) {
        // k は進み具合。0（作られた瞬間）から 1（消える瞬間）へ増える。
        // これを大きさや透明度に掛けると、時間に沿ったアニメーションになる
        const k = (millis() - e.t) / (e.type === 'flash' ? 150 : 400);
        if (k >= 1) { e.dead = true; continue; }
        noStroke();
        if (e.type === 'flash') {
            // 外側のオレンジと内側の白、2枚の円を重ねて炎のように見せる
            fill(255, 150, 0, 200 * (1 - k));       // 4つめの数値は透明度（時間とともに薄く）
            circle(e.pos.x, e.pos.y, 100 * (1 + k));   // 時間とともに大きく
            fill(255, 255, 220, 255 * (1 - k));
            circle(e.pos.x, e.pos.y, 40 * (1 + k));
        } else {
            fill(255, 40, 40, 150 * (1 - k));
            circle(e.pos.x, e.pos.y, 40 + 120 * k);
            label(`-${DAMAGE}`, e.pos.x, e.pos.y - 30 - 40 * k, '#FF4040');   // 上に浮かぶ数字
        }
    }
    effects = effects.filter(e => !e.dead);

    pop();      // 座標系を元（キャンバスの座標）に戻す

    drawHud();  // HUD は画面に固定したいので、pop() の後に描く
}

// HPバー・勝敗・状態表示。
// pop() の後なので、ここでは映像ではなくキャンバスの座標で描く
function drawHud() {
    const w = (width - 64) / 2;   // バー1本の幅（左右の余白16 × 2 と中央の間隔32 を引いて半分）

    players.forEach((pl, i) => {
        const x = 16 + i * (w + 32);

        // プレイヤー名と HP の数値。P2 は右揃えにして、左右対称に見せる
        textSize(24);
        textAlign(i ? RIGHT : LEFT, TOP);
        stroke(0);
        strokeWeight(3);
        fill(255);
        text(i ? `HP ${pl.hp} P2` : `P1 HP ${pl.hp}`, i ? x + w : x, 16);

        // バーの枠（最後の数値は角の丸み）
        stroke(255);
        strokeWeight(2);
        fill(0, 128);
        rect(x, 48, w, 24, 4);

        // 残りの HP。P2 のバーは右端から減るように、描き始めの x をずらす
        noStroke();
        fill(COLORS[i]);
        const bw = w * pl.hp / MAX_HP;
        rect(i ? x + w - bw : x, 48, bw, 24, 4);
    });

    // 検出できている手の数（動作の確認用）
    noStroke();
    fill(255);
    textSize(16);
    textAlign(LEFT, BOTTOM);
    text(`手: ${hands.length}`, 16, height - 16);

    // 決着したら、画面全体を暗くして結果を出す
    if (winner) {
        fill(0, 150);
        rect(0, 0, width, height);
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(48);
        text(winner, width / 2, height / 2 - 20);
        textSize(24);
        text('クリックでもう一度', width / 2, height / 2 + 40);
    }
}
