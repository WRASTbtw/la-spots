// Настройки сайта.
window.MAP_CONFIG = {
  title: 'LA Spots',
  center: [34.05, -118.30],
  zoom: 11,
  categories: {
    photo: { label: 'Insta-фото',  icon: '📸', color: '#ec4899' },
    see:   { label: 'Посмотреть',  icon: '👀', color: '#3b82f6' },
    play:  { label: 'Поиграть',    icon: '🎮', color: '#f59e0b' },
    beach: { label: 'Пляжи',       icon: '🏖️', color: '#14b8a6' },
    shop:  { label: 'Магазины',    icon: '👟', color: '#8b5cf6' },
  },
};

// База данных Supabase (https://supabase.com → Project Settings → API).
// Пока поля пустые, сайт работает в демо-режиме: правки сохраняются только в этом браузере.
window.SUPABASE = {
  url: '',      // например: 'https://abcdefgh.supabase.co'
  anonKey: '',  // ключ "anon public" — он публичный, его можно хранить в коде сайта
};
