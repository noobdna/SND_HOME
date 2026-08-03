const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("🚀 SND@HOME 起動成功");
});

app.listen(3000, () => {
  console.log("Server started");
});