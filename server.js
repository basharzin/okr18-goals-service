// Runs the Goals API on a PC: npm run dev -> http://localhost:3001
const app = require('./app');

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => console.log(`Goals service on http://localhost:${PORT}`));
