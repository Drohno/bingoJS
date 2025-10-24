// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Servir archivos estáticos (cliente) desde ./public
app.use(express.static("public"));

// ===== Estado del juego en servidor =====
let bombo = []; // números restantes
let numerosSalidos = []; // números ya sacados
let intervalo = null;
let juegoEnCurso = false;

// Map de clientes: socket.id -> { cartones: [ { filas: [[n]], rowFlags: [bool], bingo: bool } ], nombre }
const clientes = new Map();

// Configuración del cartón
const FILAS_POR_CARTON = 3;
const NUMEROS_POR_FILA = 7;

// ===== Funciones auxiliares =====
function resetBombo() {
  bombo = Array.from({ length: 100 }, (_, i) => i);
  numerosSalidos = [];
}

function generarCarton() {
  // Genera cartón local (cada fila 7 números sin repetición dentro del cartón)
  const disponibles = Array.from({ length: 100 }, (_, i) => i);
  const filas = [];
  for (let f = 0; f < FILAS_POR_CARTON; f++) {
    const fila = [];
    for (let j = 0; j < NUMEROS_POR_FILA; j++) {
      const idx = Math.floor(Math.random() * disponibles.length);
      fila.push(disponibles.splice(idx, 1)[0]);
    }
    filas.push(fila);
  }
  // rowFlags: trackear si esa fila ya fue avisada como línea
  return { filas, rowFlags: [false, false, false], bingo: false };
}

function sacarNumeroDelBombo() {
  if (bombo.length === 0) return null;
  const idx = Math.floor(Math.random() * bombo.length);
  const numero = bombo.splice(idx, 1)[0];
  numerosSalidos.push(numero);
  return numero;
}

// Comprobar todos los cartones de todos los clientes tras salir un número
function comprobarGanadoresGlobal() {
  const eventos = []; // { tipo: 'linea'|'bingo', socketId, cartonIndex, filaIndex }
  for (const [socketId, data] of clientes.entries()) {
    data.cartones.forEach((carton, ci) => {
      if (carton.bingo) return; // ya ganó
      let filasCompletas = 0;
      carton.filas.forEach((fila, fi) => {
        const completos = fila.every((n) => numerosSalidos.includes(n));
        if (completos) filasCompletas++;
        // si fila completa y no avisada antes -> emitir línea
        if (completos && !carton.rowFlags[fi]) {
          carton.rowFlags[fi] = true;
          eventos.push({
            tipo: "linea",
            socketId,
            cartonIndex: ci,
            filaIndex: fi,
          });
        }
      });
      if (filasCompletas === FILAS_POR_CARTON && !carton.bingo) {
        carton.bingo = true;
        eventos.push({ tipo: "bingo", socketId, cartonIndex: ci });
      }
    });
  }
  return eventos;
}

// Detener juego
function terminarJuego(razon) {
  if (intervalo) {
    clearInterval(intervalo);
    intervalo = null;
  }
  juegoEnCurso = false;
  // Notificar a todos
  io.emit("juego-terminado", { razon, numerosSalidos, quedan: bombo.length });
}

// Iniciar juego (genera bombo y cada 5s saca numero)
function iniciarJuegoAutomatico() {
  if (juegoEnCurso) return false;
  resetBombo();
  juegoEnCurso = true;
  io.emit("juego-iniciado", { quedan: bombo.length });

  intervalo = setInterval(() => {
    const numero = sacarNumeroDelBombo();
    if (numero === null) {
      terminarJuego("Se han agotado los números");
      return;
    }

    // emitir número a todos los clientes
    io.emit("numero", { numero, numerosSalidos, quedan: bombo.length });

    // comprobar líneas/bingos
    const eventos = comprobarGanadoresGlobal();
    for (const ev of eventos) {
      if (ev.tipo === "linea") {
        io.to(ev.socketId).emit("linea", {
          cartonIndex: ev.cartonIndex,
          filaIndex: ev.filaIndex,
          mensaje: `Cartón ${ev.cartonIndex + 1}: ¡LÍNEA! (fila ${
            ev.filaIndex + 1
          })`,
        });
        // También broadcast breve para mostrar que alguien ha hecho línea (opcional)
        io.emit("anuncio", {
          tipo: "linea",
          socketId: ev.socketId,
          cartonIndex: ev.cartonIndex,
        });
      } else if (ev.tipo === "bingo") {
        // anunciar a quien le corresponde y a todos
        io.to(ev.socketId).emit("bingo", {
          cartonIndex: ev.cartonIndex,
          mensaje: `¡BINGO en tu cartón ${ev.cartonIndex + 1}!`,
        });
        io.emit("anuncio", {
          tipo: "bingo",
          socketId: ev.socketId,
          cartonIndex: ev.cartonIndex,
        });
        terminarJuego(
          `BINGO: socket ${ev.socketId} (cartón ${ev.cartonIndex + 1})`
        );
        return; // salimos porque el juego terminó
      }
    }
  }, 5000);

  return true;
}

// ===== Socket.IO events =====
io.on("connection", (socket) => {
  console.log("Conexión:", socket.id);
  // Inicializar datos del cliente
  clientes.set(socket.id, {
    cartones: [],
    nombre: `Jugador-${socket.id.slice(0, 5)}`,
  });

  // Enviar estado inicial al cliente
  socket.emit("estado-inicial", {
    juegoEnCurso,
    quedan: bombo.length,
    numerosSalidos,
  });

  // solicitar cartones: { cantidad: number }
  socket.on("request-cartones", ({ cantidad = 1 }) => {
    const cliente = clientes.get(socket.id);
    cliente.cartones = cliente.cartones || [];
    for (let i = 0; i < cantidad; i++) {
      cliente.cartones.push(generarCarton());
    }
    // enviar cartones al cliente
    socket.emit("cartones", { cartones: cliente.cartones });
  });

  // cliente puede pedir iniciar (cualquier cliente puede pedirlo)
  socket.on("iniciar-juego", () => {
    const ok = iniciarJuegoAutomatico();
    socket.emit("iniciar-ack", { started: ok });
  });

  // Para solicitar estado actual (poll)
  socket.on("estado", () => {
    socket.emit("estado-actual", {
      juegoEnCurso,
      quedan: bombo.length,
      numerosSalidos,
    });
  });

  // Desconexión
  socket.on("disconnect", () => {
    console.log("Desconectado:", socket.id);
    clientes.delete(socket.id);
  });
});

// ===== Iniciar servidor =====
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
