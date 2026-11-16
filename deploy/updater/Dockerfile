# The `updater` service of docker-compose.yml (ADR 0200): the Docker CLI with its Compose plugin, bash, and the
# script. It runs as root because it holds the Docker socket, which is root on the host anyway; it listens on no port.
FROM docker:28-cli
RUN apk add --no-cache bash
COPY --chmod=755 updater.sh /usr/local/bin/updater.sh
ENTRYPOINT ["/usr/local/bin/updater.sh"]
CMD ["watch"]
