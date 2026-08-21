class RequestRateLimiter
  WINDOW_SECONDS = 10

  MAX_REQUESTS = ENV.fetch(
    "RATE_LIMIT_MAX",
    200
  ).to_i

  SCRIPT = <<~LUA
    local current
    current = redis.call("INCR", KEYS[1])
    if current == 1 then
      redis.call("EXPIRE", KEYS[1], ARGV[1])
    end
    return current
  LUA

  def self.allowed?(key)
    count = REDIS.eval(
      SCRIPT,
      keys: [ key ],
      argv: [ WINDOW_SECONDS ]
    )

    count <= MAX_REQUESTS
  rescue Redis::BaseError => error
    Rails.logger.error(
      "Redis rate limiter unavailable: #{error.message}"
    )

    true
  end
end
