import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const dbFile = join(dataDir, "database.json");
const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "127.0.0.1";
const boardSize = 19;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

let db = loadDb();
const sessions = new Map();

function loadDb() {
  if (!existsSync(dbFile)) {
    const initial = { users: [], games: [], rooms: [] };
    writeFileSync(dbFile, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(readFileSync(dbFile, "utf8"));
}

function saveDb() {
  writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return { salt, hash };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

function getSession(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const userId = sessions.get(token);
  if (!userId) return null;
  const user = db.users.find((item) => item.id === userId);
  return user ? { token, user } : null;
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "请先登录" });
    return null;
  }
  return session.user;
}

function emptyBoard() {
  return Array.from({ length: boardSize }, () => Array(boardSize).fill(null));
}

function createRoom({ host, mode }) {
  const room = {
    id: randomBytes(5).toString("hex").toUpperCase(),
    mode,
    status: mode === "ai" ? "playing" : "waiting",
    players: {
      black: host.id,
      white: mode === "ai" ? "AI" : null,
    },
    board: emptyBoard(),
    captures: { black: 0, white: 0 },
    turn: "black",
    moves: [],
    emojis: [],
    winner: null,
    resultReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.rooms.unshift(room);
  saveDb();
  return room;
}

function roomForClient(room) {
  return {
    ...room,
    players: {
      black: playerLabel(room.players.black),
      white: playerLabel(room.players.white),
    },
  };
}

function playerLabel(id) {
  if (!id) return null;
  if (id === "AI") return { id: "AI", username: "AI 棋手" };
  const user = db.users.find((item) => item.id === id);
  return user ? publicUser(user) : { id, username: "未知玩家" };
}

function colorFor(room, userId) {
  if (room.players.black === userId) return "black";
  if (room.players.white === userId) return "white";
  return null;
}

function opponent(color) {
  return color === "black" ? "white" : "black";
}

function isInside(x, y) {
  return x >= 0 && y >= 0 && x < boardSize && y < boardSize;
}

function neighbors(x, y) {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].filter(([nx, ny]) => isInside(nx, ny));
}

function collectGroup(board, x, y) {
  const color = board[y][x];
  const seen = new Set();
  const stones = [];
  const liberties = new Set();
  const stack = [[x, y]];

  while (stack.length) {
    const [cx, cy] = stack.pop();
    const key = `${cx},${cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stones.push([cx, cy]);

    for (const [nx, ny] of neighbors(cx, cy)) {
      const value = board[ny][nx];
      if (!value) liberties.add(`${nx},${ny}`);
      else if (value === color) stack.push([nx, ny]);
    }
  }

  return { stones, liberties };
}

function applyMove(room, x, y, color) {
  if (room.status !== "playing") return { error: "对局未开始" };
  if (room.winner) return { error: "对局已结束" };
  if (room.turn !== color) return { error: "还没轮到你" };
  if (!isInside(x, y) || room.board[y][x]) return { error: "这里不能落子" };

  const nextBoard = room.board.map((row) => [...row]);
  nextBoard[y][x] = color;
  const enemy = opponent(color);
  let captured = 0;

  for (const [nx, ny] of neighbors(x, y)) {
    if (nextBoard[ny][nx] !== enemy) continue;
    const group = collectGroup(nextBoard, nx, ny);
    if (group.liberties.size === 0) {
      for (const [sx, sy] of group.stones) nextBoard[sy][sx] = null;
      captured += group.stones.length;
    }
  }

  const ownGroup = collectGroup(nextBoard, x, y);
  if (ownGroup.liberties.size === 0) return { error: "不能自杀落子" };

  room.board = nextBoard;
  room.captures[color] += captured;
  room.moves.push({ x, y, color, captured, at: new Date().toISOString() });
  room.turn = enemy;
  room.updatedAt = new Date().toISOString();
  return { ok: true };
}

function estimateTerritory(room) {
  const visited = new Set();
  const score = {
    black: room.captures.black,
    white: room.captures.white + 6.5,
  };

  for (let y = 0; y < boardSize; y += 1) {
    for (let x = 0; x < boardSize; x += 1) {
      const value = room.board[y][x];
      if (value) {
        score[value] += 1;
        continue;
      }

      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      const area = [];
      const border = new Set();
      const stack = [[x, y]];
      visited.add(key);

      while (stack.length) {
        const [cx, cy] = stack.pop();
        area.push([cx, cy]);
        for (const [nx, ny] of neighbors(cx, cy)) {
          const next = room.board[ny][nx];
          if (next) border.add(next);
          else {
            const nKey = `${nx},${ny}`;
            if (!visited.has(nKey)) {
              visited.add(nKey);
              stack.push([nx, ny]);
            }
          }
        }
      }

      if (border.size === 1) {
        score[[...border][0]] += area.length;
      }
    }
  }

  return score;
}

function finishRoom(room, winnerColor, reason) {
  if (room.winner) return;
  room.winner = winnerColor;
  room.resultReason = reason;
  room.status = "finished";
  room.updatedAt = new Date().toISOString();
  db.games.unshift({
    id: randomBytes(7).toString("hex"),
    roomId: room.id,
    players: room.players,
    winner: winnerColor,
    reason,
    moves: room.moves.length,
    finishedAt: room.updatedAt,
  });
  saveDb();
}

function chooseAiMove(room) {
  const candidates = [];
  for (let y = 0; y < boardSize; y += 1) {
    for (let x = 0; x < boardSize; x += 1) {
      if (room.board[y][x]) continue;
      if (room.moves.length && !hasNeighbor(room.board, x, y, 2)) continue;
      const score = scoreAiPoint(room.board, x, y, "white") + scoreAiPoint(room.board, x, y, "black") * 0.82;
      const center = 20 - Math.abs(9 - x) - Math.abs(9 - y);
      candidates.push({ x, y, score: score + center });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || { x: 9, y: 9 };
}

function hasNeighbor(board, x, y, range) {
  for (let dy = -range; dy <= range; dy += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (isInside(nx, ny) && board[ny][nx]) return true;
    }
  }
  return false;
}

function scoreAiPoint(board, x, y, color) {
  let score = 0;
  for (const [nx, ny] of neighbors(x, y)) {
    if (board[ny][nx] === color) score += 16;
    else if (board[ny][nx] === opponent(color)) score += 8;
    else score += 2;
  }
  return score;
}

function ranking() {
  return db.users
    .map((user) => {
      const recent = db.games
        .filter((game) => game.players.black === user.id || game.players.white === user.id)
        .slice(0, 10);
      const wins = recent.filter((game) => {
        const color = game.players.black === user.id ? "black" : "white";
        return game.winner === color;
      }).length;
      return {
        ...publicUser(user),
        recentGames: recent.length,
        recentWins: wins,
        winRate: recent.length ? Math.round((wins / recent.length) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.winRate - a.winRate || b.recentGames - a.recentGames || a.username.localeCompare(b.username));
}

async function handleApi(req, res, path) {
  try {
    if (req.method === "POST" && path === "/api/register") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!/^[\w\u4e00-\u9fa5-]{2,18}$/.test(username)) return json(res, 400, { error: "用户名需为 2-18 位中英文、数字或下划线" });
      if (password.length < 6) return json(res, 400, { error: "密码至少 6 位" });
      if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: "用户名已存在" });
      const passwordData = hashPassword(password);
      const user = {
        id: randomBytes(8).toString("hex"),
        username,
        password: passwordData.hash,
        salt: passwordData.salt,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      saveDb();
      const token = randomBytes(24).toString("hex");
      sessions.set(token, user.id);
      return json(res, 201, { token, user: publicUser(user) });
    }

    if (req.method === "POST" && path === "/api/login") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user = db.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
      if (!user) return json(res, 401, { error: "账号或密码错误" });
      const hashed = hashPassword(password, user.salt);
      if (hashed.hash !== user.password) return json(res, 401, { error: "账号或密码错误" });
      const token = randomBytes(24).toString("hex");
      sessions.set(token, user.id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (req.method === "GET" && path === "/api/me") {
      const session = getSession(req);
      return json(res, 200, { user: session ? publicUser(session.user) : null });
    }

    if (req.method === "GET" && path === "/api/ranking") {
      return json(res, 200, { ranking: ranking() });
    }

    if (req.method === "GET" && path === "/api/rooms") {
      const rooms = db.rooms.filter((room) => room.status !== "finished").slice(0, 20).map(roomForClient);
      return json(res, 200, { rooms });
    }

    if (req.method === "POST" && path === "/api/rooms") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const mode = body.mode === "ai" ? "ai" : "online";
      const room = createRoom({ host: user, mode });
      return json(res, 201, { room: roomForClient(room) });
    }

    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
    if (roomMatch) {
      const room = db.rooms.find((item) => item.id === roomMatch[1]);
      if (!room) return json(res, 404, { error: "房间不存在" });
      const action = roomMatch[2];

      if (req.method === "GET" && !action) return json(res, 200, { room: roomForClient(room) });

      const user = requireUser(req, res);
      if (!user) return;

      if (req.method === "POST" && action === "join") {
        if (room.mode !== "online") return json(res, 400, { error: "这个房间不是联机房" });
        if (!room.players.white && room.players.black !== user.id) {
          room.players.white = user.id;
          room.status = "playing";
          room.updatedAt = new Date().toISOString();
          saveDb();
        }
        return json(res, 200, { room: roomForClient(room) });
      }

      if (req.method === "POST" && action === "move") {
        const body = await readBody(req);
        const color = colorFor(room, user.id);
        if (!color) return json(res, 403, { error: "你不是本局玩家" });
        const result = applyMove(room, Number(body.x), Number(body.y), color);
        if (result.error) return json(res, 400, { error: result.error });
        if (room.mode === "ai" && room.turn === "white" && !room.winner) {
          const aiMove = chooseAiMove(room);
          applyMove(room, aiMove.x, aiMove.y, "white");
        }
        saveDb();
        return json(res, 200, { room: roomForClient(room) });
      }

      if (req.method === "POST" && action === "emoji") {
        const body = await readBody(req);
        const color = colorFor(room, user.id);
        if (!color) return json(res, 403, { error: "你不是本局玩家" });
        const emoji = String(body.emoji || "").slice(0, 4);
        if (!emoji) return json(res, 400, { error: "请选择表情" });
        room.emojis.unshift({ emoji, from: color, at: new Date().toISOString() });
        room.emojis = room.emojis.slice(0, 12);
        room.updatedAt = new Date().toISOString();
        saveDb();
        return json(res, 200, { room: roomForClient(room) });
      }

      if (req.method === "POST" && action === "resign") {
        const color = colorFor(room, user.id);
        if (!color) return json(res, 403, { error: "你不是本局玩家" });
        finishRoom(room, opponent(color), "resign");
        return json(res, 200, { room: roomForClient(room) });
      }

      if (req.method === "POST" && action === "score") {
        const color = colorFor(room, user.id);
        if (!color) return json(res, 403, { error: "你不是本局玩家" });
        const score = estimateTerritory(room);
        finishRoom(room, score.black > score.white ? "black" : "white", `score ${score.black.toFixed(1)}:${score.white.toFixed(1)}`);
        return json(res, 200, { room: roomForClient(room), score });
      }
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "服务器错误" });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(publicDir, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    const fallback = readFileSync(join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
    res.end(fallback);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  return serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`Go game server running at http://${host}:${port}`);
});
