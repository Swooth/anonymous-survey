content = open("server.js", "r", encoding="utf-8").read()
old = "app.use(express.json());"
new = """app.use(express.json());
// Override Railway CSP to allow eval
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https: *; style-src 'self' 'unsafe-inline' https: *; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: *; font-src 'self' data: https: *; connect-src 'self' https: *; media-src 'self' https: *; object-src 'none'; frame-src 'self' https: *;");
  next();
});
"""
content = content.replace(old, new, 1)
with open("server.js", "w", encoding="utf-8") as f:
    f.write(content)
print("CSP override added")
