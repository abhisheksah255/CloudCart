# CloudCart frontend (static SPA served by nginx)
#
# Build args let the SAME Dockerfile produce two images:
#   docker build --build-arg NGINX_CONF=nginx.local.conf .   -> local (nginx also proxies /api/*)
#   docker build .                                            -> AWS   (static only, ALB routes /api/*)
FROM nginx:1.27-alpine

ARG NGINX_CONF=nginx.aws.conf

# Remove the default site and install ours
RUN rm /etc/nginx/conf.d/default.conf
COPY ${NGINX_CONF}     /etc/nginx/conf.d/default.conf
COPY proxy_params.conf /etc/nginx/proxy_params.conf

# Static files
COPY index.html style.css app.js /usr/share/nginx/html/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/health || exit 1
CMD ["nginx", "-g", "daemon off;"]
