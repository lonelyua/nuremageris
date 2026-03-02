export const benchConfig = {
  warmup: 10,
  iterations: 30,
  concurrency: 5,

  dataSizes: {
    S: { users: 1_000, products: 500, ordersPerUser: 2 },
    M: { users: 10_000, products: 2_000, ordersPerUser: 5 },
    L: { users: 100_000, products: 10_000, ordersPerUser: 10 },
  },

  defaultSize: "M" as const,
};
