FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

RUN npm install --global @openai/codex@0.141.0
COPY dist/project-ignored-dirs.js /opt/open-design/
COPY dist/platform/hosted-task-wire.js dist/platform/hosted-task-files.js dist/platform/hosted-task-worker.js /opt/open-design/platform/

USER 1000:1000
CMD ["node", "/opt/open-design/platform/hosted-task-worker.js"]
