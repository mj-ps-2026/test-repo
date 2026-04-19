const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Hello World</title>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;600&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #ff6b6b, #feca57, #ff9ff3, #ff6b6b);
          background-size: 300% 300%;
          animation: sunsetShift 10s ease infinite;
          font-family: 'Poppins', sans-serif;
        }
        .container {
          text-align: center;
          animation: fadeIn 1s ease-out, float 3s ease-in-out infinite;
        }
        h1 {
          font-size: 5rem;
          font-weight: 600;
          color: white;
          text-shadow: 0 4px 20px rgba(0,0,0,0.3);
          letter-spacing: -2px;
        }
        p {
          font-size: 1.2rem;
          color: rgba(255,255,255,0.9);
          margin-top: 1rem;
          font-weight: 300;
        }
        @keyframes sunsetShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Hello World</h1>
        <p>Welcome to my Node.js app</p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});