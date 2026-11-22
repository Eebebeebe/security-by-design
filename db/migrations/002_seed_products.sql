-- Startsortiment. Admin-Benutzer wird NICHT hier angelegt (kein Passwort im Repo),
-- sondern beim Start aus ADMIN_USERNAME / ADMIN_PASSWORD.
INSERT INTO products (name, description, category, price_cents, stock) VALUES
  ('Margherita',     'Tomatensauce, Mozzarella, Basilikum',                  'pizza',   890, 50),
  ('Salami',         'Tomatensauce, Mozzarella, Salami',                     'pizza',   990, 40),
  ('Funghi',         'Tomatensauce, Mozzarella, Champignons',                'pizza',   950, 35),
  ('Quattro Formaggi','Mozzarella, Gorgonzola, Parmesan, Fontina',           'pizza',  1190, 25),
  ('Diavola',        'Tomatensauce, Mozzarella, scharfe Salami, Peperoni',   'pizza',  1090, 30),
  ('Vegetaria',      'Tomatensauce, Mozzarella, Paprika, Zucchini, Oliven',  'pizza',  1050, 30),
  ('Cola 0,33 l',    'Gekühlt',                                              'drink',   250, 100),
  ('Wasser 0,5 l',   'Still',                                                'drink',   200, 100),
  ('Tiramisu',       'Hausgemacht',                                          'dessert', 490, 20),
  ('Panna Cotta',    'Mit Beerensauce',                                      'dessert', 450, 20);
