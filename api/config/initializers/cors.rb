Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    # Defaults to the Vite dev server; override with a comma-separated list
    # (e.g. the CloudFront domain in production).
    origins(
      ENV.fetch("CORS_ORIGINS", "http://localhost:5173")
        .split(",")
        .map(&:strip)
        .reject(&:empty?)
    )

    resource "*",
      headers: :any,
      methods: [ :get, :post, :options ],
      expose: [ "X-Request-Id" ]
  end
end
