# Gateway Web API prefix

Guion Web's HTTP Service uses `/api/v1/web/*` instead of bare `/v1/*` routes so its direct service contract and the FlickNote Gateway contract are identical. This assigns the service a clear owner namespace in FlickNote's versioned API surface without introducing path rewriting or a compatibility alias.
