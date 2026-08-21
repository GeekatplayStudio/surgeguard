Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :purchase_requests,
        only: [ :index, :create ]
      get "metrics",
        to: "metrics#show"
    end
  end

  get "up",
    to: "rails/health#show"
end
