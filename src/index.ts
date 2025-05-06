// src/index.ts # minimal setup to check Worker OK

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("✅ Air Quality Worker is running!", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};
