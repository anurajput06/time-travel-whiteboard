// After you deploy the server (see README.md), put its URL here.
// Example once deployed on Render: "https://my-whiteboard-server.onrender.com"
// While testing locally: "http://localhost:8080"
window.WHITEBOARD_CONFIG = {
  SERVER_HTTP_URL: "http://localhost:8080",   // used for REST calls (auth, fork, merge)
  SERVER_WS_URL: "ws://localhost:8080",        // used for the live WebSocket connection
  // From Google Cloud Console -> APIs & Services -> Credentials -> OAuth Client ID
  // (Web application). See README "Auth setup" for the exact free steps.
  GOOGLE_CLIENT_ID: "880429209980-uigou6uijadbrdgks389go154ipeo51j.apps.googleusercontent.com"
};
window.WHITEBOARD_CONFIG = {
  SERVER_HTTP_URL: "https://whiteboard-server-ecer.onrender.com",
  SERVER_WS_URL: "wss://whiteboard-server-ecer.onrender.com",
  GOOGLE_CLIENT_ID: "880429209980-uigou6uijadbrdgks389go154ipeo51j.apps.googleusercontent.com" // Yahan apni asli Google Client ID daal dena
};