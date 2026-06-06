const boardCanvas = document.querySelector("#board");
const ctx = boardCanvas.getContext("2d");
const statusText = document.querySelector("#statusText");
const turnDot = document.querySelector("#turnDot");
const turnText = document.querySelector("#turnText");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const authCard = document.querySelector("#authCard");
const profileCard = document.querySelector("#profileCard");
const helloText = document.querySelector("#helloText");
const onlineRoomButton = document.querySelector("#onlineRoomButton");
const aiRoomButton = document.querySelector("#aiRoomButton");
const roomInfo = document.querySelector("#roomInfo");
const roomList = document.querySelector("#roomList");
const rankingList = document.querySelector("#rankingList");
const emojiFeed = document.querySelector("#emojiFeed");
const scoreButton = document.querySelector("#scoreButton");
const resignButton = document.querySelector("#resignButton");
const toast = document.querySelector("#toast");

const size = 19;
const starPoints = [
  [3, 3],
  [9, 3],
  [15, 3],
  [3, 9],
  [9, 9],
  [15, 9],
  [3, 15],
  [9, 15],
  [15, 15],
];

let token = localStorage.getItem("go_token") || "";
let user = null;
let room = null;
let refreshTimer = null;
let toastTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

async function loginLike(mode) {
  try {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const data = await api(`/api/${mode}`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    token = data.token;
    user = data.user;
    localStorage.setItem("go_token", token);
    renderAuth();
    await refreshAll();
    showToast(mode === "login" ? "登录成功" : "注册成功");
  } catch (error) {
    showToast(error.message);
  }
}

function renderAuth() {
  if (user) {
    authCard.classList.add("hidden");
    profileCard.classList.remove("hidden");
    helloText.textContent = `你好，${user.username}`;
  } else {
    authCard.classList.remove("hidden");
    profileCard.classList.add("hidden");
  }
}

async function refreshAll() {
  await Promise.all([refreshRanking(), refreshRooms(), refreshRoom()]);
}

async function refreshRanking() {
  const data = await api("/api/ranking");
  rankingList.innerHTML = data.ranking.length
    ? data.ranking
        .map(
          (item, index) => `
            <div class="rank-card">
              <span class="rank-num">${index + 1}</span>
              <div>
                <strong>${escapeHtml(item.username)}</strong>
                <div class="meta">近 ${item.recentGames} 局，胜 ${item.recentWins} 局</div>
              </div>
              <span class="rank-rate">${item.winRate}%</span>
            </div>
          `
        )
        .join("")
    : `<div class="meta">暂无排名</div>`;
}

async function refreshRooms() {
  const data = await api("/api/rooms");
  roomList.innerHTML = data.rooms.length
    ? data.rooms
        .map(
          (item) => `
            <div class="room-card">
              <strong>${item.id}</strong>
              <div class="meta">${item.mode === "ai" ? "人机" : "联机"} · ${roomStatus(item)}</div>
              <div class="meta">黑：${item.players.black?.username || "-"} ｜ 白：${item.players.white?.username || "等待中"}</div>
              ${item.mode === "online" && item.status === "waiting" ? `<button type="button" data-room="${item.id}">加入</button>` : ""}
            </div>
          `
        )
        .join("")
    : `<div class="meta">暂无可加入房间</div>`;
}

async function refreshRoom() {
  if (!room) {
    renderRoom();
    return;
  }
  try {
    const data = await api(`/api/rooms/${room.id}`);
    room = data.room;
    renderRoom();
  } catch {
    room = null;
    renderRoom();
  }
}

function roomStatus(item) {
  if (item.status === "waiting") return "等待对手";
  if (item.status === "finished") return "已结束";
  return "对局中";
}

async function createRoom(mode) {
  if (!user) return showToast("请先登录");
  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    room = data.room;
    startRefresh();
    await refreshAll();
    showToast(mode === "ai" ? "已开始人机对战" : `联机房 ${room.id} 已创建`);
  } catch (error) {
    showToast(error.message);
  }
}

async function joinRoom(roomId) {
  if (!user) return showToast("请先登录");
  try {
    const data = await api(`/api/rooms/${roomId}/join`, { method: "POST", body: "{}" });
    room = data.room;
    startRefresh();
    await refreshAll();
    showToast("已加入房间");
  } catch (error) {
    showToast(error.message);
  }
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 1800);
}

function renderRoom() {
  const active = Boolean(room && room.status === "playing" && user && playerColor());
  scoreButton.disabled = !active;
  resignButton.disabled = !active;

  if (!room) {
    roomInfo.textContent = "暂无房间";
    emojiFeed.innerHTML = "";
    statusText.textContent = user ? "创建或加入房间开始对局" : "登录后开始对局";
    draw();
    return;
  }

  const black = room.players.black?.username || "-";
  const white = room.players.white?.username || "等待中";
  roomInfo.innerHTML = `
    <strong>房间 ${room.id}</strong>
    <span>${room.mode === "ai" ? "人机对战" : "双人联机"} · ${roomStatus(room)}</span>
    <span>黑：${black} ｜ 白：${white}</span>
  `;

  const current = room.turn === "black" ? "黑方" : "白方";
  turnDot.className = `stone-dot ${room.turn}`;
  turnText.textContent = current;

  if (room.winner) {
    statusText.textContent = `${room.winner === "black" ? "黑方" : "白方"}获胜 · ${resultText(room.resultReason)}`;
  } else if (room.status === "waiting") {
    statusText.textContent = "等待白方加入";
  } else {
    const mine = playerColor();
    statusText.textContent = mine === room.turn ? "轮到你落子" : `轮到${current}`;
  }

  emojiFeed.innerHTML = room.emojis
    .map((item) => `<span class="emoji-chip">${item.from === "black" ? "黑" : "白"} ${escapeHtml(item.emoji)}</span>`)
    .join("");
  draw();
}

function resultText(reason) {
  if (!reason) return "结束";
  if (reason === "resign") return "认输";
  if (reason.startsWith("score")) return `数子 ${reason.replace("score ", "")}`;
  return reason;
}

function playerColor() {
  if (!room || !user) return null;
  if (room.players.black?.id === user.id) return "black";
  if (room.players.white?.id === user.id) return "white";
  return null;
}

function metrics(resize = true) {
  const rect = boardCanvas.getBoundingClientRect();
  if (resize) {
    const dpr = window.devicePixelRatio || 1;
    boardCanvas.width = Math.round(rect.width * dpr);
    boardCanvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const padding = rect.width * 0.056;
  const gap = (rect.width - padding * 2) / (size - 1);
  return { width: rect.width, height: rect.height, padding, gap };
}

function draw() {
  const { width, height, padding, gap } = metrics(true);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#e7c486");
  gradient.addColorStop(0.56, "#d2a35d");
  gradient.addColorStop(1, "#bd8746");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#47331e";
  ctx.lineWidth = 1.35;
  for (let i = 0; i < size; i += 1) {
    const p = padding + i * gap;
    ctx.beginPath();
    ctx.moveTo(padding, p);
    ctx.lineTo(width - padding, p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p, padding);
    ctx.lineTo(p, height - padding);
    ctx.stroke();
  }

  ctx.fillStyle = "#47331e";
  for (const [x, y] of starPoints) {
    ctx.beginPath();
    ctx.arc(padding + x * gap, padding + y * gap, Math.max(2.6, gap * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }

  const board = room?.board || [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (board[y]?.[x]) drawStone(x, y, board[y][x], padding, gap);
    }
  }
}

function drawStone(x, y, color, padding, gap) {
  const cx = padding + x * gap;
  const cy = padding + y * gap;
  const radius = gap * 0.43;
  ctx.save();
  ctx.shadowColor = "rgba(21, 16, 10, 0.35)";
  ctx.shadowBlur = radius * 0.35;
  ctx.shadowOffsetY = radius * 0.15;
  const gradient = ctx.createRadialGradient(cx - radius * 0.28, cy - radius * 0.3, radius * 0.08, cx, cy, radius);
  if (color === "black") {
    gradient.addColorStop(0, "#71777e");
    gradient.addColorStop(0.52, "#171b20");
    gradient.addColorStop(1, "#020304");
  } else {
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.62, "#f0eadf");
    gradient.addColorStop(1, "#b7ad9f");
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function canvasCell(event) {
  const rect = boardCanvas.getBoundingClientRect();
  const { padding, gap } = metrics(false);
  const x = Math.round((event.clientX - rect.left - padding) / gap);
  const y = Math.round((event.clientY - rect.top - padding) / gap);
  const px = padding + x * gap;
  const py = padding + y * gap;
  if (Math.hypot(event.clientX - rect.left - px, event.clientY - rect.top - py) > gap * 0.48) return null;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x, y };
}

async function playMove(x, y) {
  if (!room || room.status !== "playing") return;
  if (playerColor() !== room.turn) return showToast("还没轮到你");
  try {
    const data = await api(`/api/rooms/${room.id}/move`, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
    room = data.room;
    await refreshAll();
  } catch (error) {
    showToast(error.message);
  }
}

async function roomAction(action) {
  if (!room) return;
  try {
    const data = await api(`/api/rooms/${room.id}/${action}`, { method: "POST", body: "{}" });
    room = data.room;
    await refreshAll();
  } catch (error) {
    showToast(error.message);
  }
}

async function sendEmoji(emoji) {
  if (!room) return showToast("请先进入房间");
  try {
    const data = await api(`/api/rooms/${room.id}/emoji`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
    room = data.room;
    renderRoom();
  } catch (error) {
    showToast(error.message);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

loginButton.addEventListener("click", () => loginLike("login"));
registerButton.addEventListener("click", () => loginLike("register"));
onlineRoomButton.addEventListener("click", () => createRoom("online"));
aiRoomButton.addEventListener("click", () => createRoom("ai"));
scoreButton.addEventListener("click", () => roomAction("score"));
resignButton.addEventListener("click", () => roomAction("resign"));
roomList.addEventListener("click", (event) => {
  const id = event.target.dataset.room;
  if (id) joinRoom(id);
});
document.querySelectorAll(".emoji-button").forEach((button) => {
  button.addEventListener("click", () => sendEmoji(button.dataset.emoji));
});
boardCanvas.addEventListener("pointerdown", (event) => {
  const cell = canvasCell(event);
  if (cell) playMove(cell.x, cell.y);
});
window.addEventListener("resize", draw);

(async function boot() {
  try {
    if (token) {
      const data = await api("/api/me");
      user = data.user;
      if (!user) localStorage.removeItem("go_token");
    }
    renderAuth();
    await refreshAll();
    startRefresh();
  } catch {
    localStorage.removeItem("go_token");
    token = "";
    renderAuth();
    draw();
  }
})();
