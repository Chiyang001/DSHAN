FROM node:24-alpine
WORKDIR /app
RUN npm install --ignore-scripts --save-exact ws@8.22.0
COPY signal-server.js ./signal-server.mjs
ENV HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "signal-server.mjs"]
