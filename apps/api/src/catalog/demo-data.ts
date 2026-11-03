/** Illustrative fixtures only; prices, stock and photos are not commercial offers. */
export const demoCategories = [
  { name: "Классические", slug: "demo-classic" },
  { name: "Спортивные", slug: "demo-sport" },
  { name: "Механические", slug: "demo-automatic" }
] as const;

export const demoWatches = [
  { brand: "Casio", title: "Casio Vintage A168", sku: "DEMO-CASIO-A168", category: 0, priceMinor: 18900, quantity: 8, color: "Серебристый", mechanism: "Кварцевый", photo: "classic.jpg" },
  { brand: "Casio", title: "Casio G-Shock GA-2100", sku: "DEMO-CASIO-GA2100", category: 1, priceMinor: 42900, quantity: 5, color: "Чёрный", mechanism: "Кварцевый", photo: "sport.jpg" },
  { brand: "Seiko", title: "Seiko 5 Sports", sku: "DEMO-SEIKO-5", category: 2, priceMinor: 99000, quantity: 3, color: "Синий", mechanism: "Автоматический", photo: "classic.jpg" },
  { brand: "Orient", title: "Orient Bambino", sku: "DEMO-ORIENT-BAMBINO", category: 2, priceMinor: 74900, quantity: 2, color: "Кремовый", mechanism: "Автоматический", photo: "dress.jpg" },
  { brand: "Citizen", title: "Citizen Eco-Drive", sku: "DEMO-CITIZEN-ECO", category: 0, priceMinor: 85900, quantity: 4, color: "Серебристый", mechanism: "Солнечная батарея", photo: "classic.jpg" },
  { brand: "Tissot", title: "Tissot PRX Quartz", sku: "DEMO-TISSOT-PRX", category: 0, priceMinor: 139000, quantity: 1, color: "Синий", mechanism: "Кварцевый", photo: "dress.jpg" },
  { brand: "Timex", title: "Timex Weekender", sku: "DEMO-TIMEX-WEEKENDER", category: 0, priceMinor: 24900, quantity: 6, color: "Оливковый", mechanism: "Кварцевый", photo: "sport.jpg" },
  { brand: "Seiko", title: "Seiko Presage", sku: "DEMO-SEIKO-PRESAGE", category: 2, priceMinor: 159000, quantity: 0, color: "Голубой", mechanism: "Автоматический", photo: "classic.jpg" }
] as const;
