// Import the express module
const express = require('express');

// Create an instance of the express application
const app = express();

// Define a route for the root path ('/')
app.get('/', (req, res) => {
  res.send('Hello, World! from admin');
});

// Set the port for the server to listen on
const port = 3002;

// Start the server and listen on the specified port
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
