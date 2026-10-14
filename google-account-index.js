function main() {
  try {
    var hubUrl = 'https://hub.groscloud.com/'; // Endpoint для уведомлений (open-id дальше форвардит в /google/account)
    var alertLimit = 500; // Минимальный остаток для отправки уведомления


    var account = AdsApp.currentAccount();
    var accountId = account.getCustomerId(); // Получаем ID рекламного кабинета
    var currencyCode = account.getCurrencyCode(); // Получаем валюту рекламного кабинета

    var accountStatsToday = account.getStatsFor("TODAY");
    var accountBalanceToday = accountStatsToday.getCost(); // Получаем расход за сегодня
    var clicks = accountStatsToday.getClicks(); // Получаем количество кликов за сегодня
    var impressions = accountStatsToday.getImpressions(); // Получаем количество показов за сегодня

    var accountStatsAllTime = account.getStatsFor("ALL_TIME");
    var accountBalanceAllTime = accountStatsAllTime.getCost(); // Получаем расход за все время

    // Логируем только ключевые значения
    Logger.log('Расход за сегодня: ' + accountBalanceToday);
    Logger.log('Клики за сегодня: ' + clicks);
    Logger.log('Показы за сегодня: ' + impressions);

    if (accountBalanceToday === 0) {
      //Logger.log("Расход за сегодня равен 0. Сообщение не будет отправлено.");
      //return; // Завершаем выполнение функции, если расход равен 0
    }

    var ctr = (impressions > 0) ? (clicks / impressions) * 100 : 0; // CTR в процентах
    var cpm = (impressions > 0) ? (accountBalanceToday / impressions) * 1000 : 0; // CPM
    var cpc = (clicks > 0) ? (accountBalanceToday / clicks) : 0; // CPC

    var exchangeRate = getConversionRate(currencyCode);
    if (exchangeRate === null) {
      //Logger.log('Не удалось получить курс для ' + currencyCode);
      //return; // Завершаем выполнение функции, если курс не удалось получить
      exchangeRate = 1;
    }

    var accountBalanceTodayUSD = accountBalanceToday / exchangeRate; // Конвертируем расход за сегодня в USD
    var cpcUSD = cpc / exchangeRate; // Конвертируем CPC в USD
    var cpmUSD = cpm / exchangeRate; // Конвертируем CPM в USD
    var accountBalanceAllTimeUSD = accountBalanceAllTime / exchangeRate; // Конвертируем расход за все время в USD

    var adPerformanceData = getAdPerformanceData();

    // Расчет расходов и кликов для Others
    var youtubeCost = parseFloat(adPerformanceData.youtube.cost);
    var youtubeClicks = adPerformanceData.youtube.clicks;

    var othersCost = accountBalanceToday - youtubeCost; // Расходы по другим источникам
    var othersClicks = clicks - youtubeClicks; // Клики по другим источникам
    var othersCpc = (othersClicks > 0) ? (othersCost / othersClicks).toFixed(2) : '0.00'; // CPC для Others

    // Логируем только итоговые значения
    Logger.log('Итоговые значения: YouTube - ' + adPerformanceData.youtube.impressions + ' показов, ' + adPerformanceData.youtube.clicks + ' кликов, ' + adPerformanceData.youtube.cost + ' затрат');
    Logger.log('Расходы по Others: ' + othersCost.toFixed(2));
    Logger.log('Клики по Others: ' + othersClicks);
    Logger.log('CPC по Others: ' + othersCpc);

    var balanceInfo = getBalanceInfo(currencyCode);

    var report = {
      accountId: accountId,
      currencyCode: currencyCode,
      created_at: '', // filled automatically
      profile_name: '', // filled automatically
      version: '1.2.0',
      stats: {
        today: {
          cost: parseFloat(accountBalanceToday.toFixed(2)),
          costUsd: parseFloat(accountBalanceTodayUSD.toFixed(2)),
          clicks: clicks,
          impressions: impressions,
          ctrPct: parseFloat(ctr.toFixed(2)),
          cpm: parseFloat(cpm.toFixed(2)),
          cpmUsd: parseFloat(cpmUSD.toFixed(2)),
          cpc: parseFloat(cpc.toFixed(2)),
          cpcUsd: parseFloat(cpcUSD.toFixed(2))
        },
        allTime: {
          cost: parseFloat(accountBalanceAllTime.toFixed(2)),
          costUsd: parseFloat(accountBalanceAllTimeUSD.toFixed(2))
        }
      },
      breakdown: {
        youtube: {
          impressions: adPerformanceData.youtube.impressions,
          clicks: adPerformanceData.youtube.clicks,
          cost: parseFloat(adPerformanceData.youtube.cost),
          cpc: parseFloat(adPerformanceData.youtube.cpc)
        },
        others: {
          cost: parseFloat(othersCost.toFixed(2)),
          clicks: othersClicks,
          cpc: parseFloat(othersCpc)
        }
      },
      balance: balanceInfo
    };

    var budgetMessage = checkBudgetAndNotify(accountId, currencyCode, alertLimit);
    if (budgetMessage) {
      report.budget = { text: budgetMessage };
    }

    var moderationMessage = getModerationMessage();
    if (moderationMessage) {
      report.moderation = { summary: moderationMessage };
    }

    var jwt = generateJwt(global_profile_id, global_profile_name);
    sendMessageToHub(hubUrl, report, jwt);
  } catch (e) {
    Logger.log('Ошибка выполнения функции main: ' + e);
  }
}

function generateJwt(profile_id, sid) {
  function simpleHash(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash;
      }
      return hash.toString(36);
  }

  function base64urlEncode(str) {
      const base64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let result = '';
      let i = 0;
      while (i < str.length) {
          const a = str.charCodeAt(i++);
          const b = i < str.length ? str.charCodeAt(i++) : 0;
          const c = i < str.length ? str.charCodeAt(i++) : 0;
          const bitmap = (a << 16) | (b << 8) | c;
          result += base64chars.charAt((bitmap >> 18) & 63);
          result += base64chars.charAt((bitmap >> 12) & 63);
          result += base64chars.charAt((bitmap >> 6) & 63);
          result += base64chars.charAt(bitmap & 63);
      }
      const padding = str.length % 3;
      if (padding > 0) result = result.slice(0, padding - 3);
      return result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  if (!profile_id || !sid) return null;

  const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ profile_id, iat: now, exp: now + 300 });
  const encodedHeader = base64urlEncode(header);
  const encodedPayload = base64urlEncode(payload);
  const signature = simpleHash(encodedHeader + '.' + encodedPayload + '.' + sid);
  const encodedSignature = base64urlEncode(signature);

  return encodedHeader + '.' + encodedPayload + '.' + encodedSignature;
}

function getModerationMessage() {
  try {
    // По сути "модерация аккаунта" в Ads Scripts обычно доступна только через модерацию
    // объявлений/активов (approval_status / review_status), а не единый статус аккаунта.

    var disapprovedAdsCount = 0;
    try {
      var disapprovedIterator = AdsApp.ads()
        .withCondition('ad_group_ad.status = ENABLED')
        .withCondition('campaign.status = ENABLED')
        .withCondition('ad_group.status = ENABLED')
        .withCondition('ad_group_ad.policy_summary.approval_status = DISAPPROVED')
        .get();

      disapprovedAdsCount = disapprovedIterator.totalNumEntities();
    } catch (e) {
      Logger.log('Ошибка получения DISAPPROVED: ' + e);
    }

    var underReviewAdsCount = 0;
    try {
      var underReviewIterator = AdsApp.ads()
        .withCondition('ad_group_ad.status = ENABLED')
        .withCondition('campaign.status = ENABLED')
        .withCondition('ad_group.status = ENABLED')
        // В Google Ads Scripts для review_status рабочее значение — REVIEW_IN_PROGRESS.
        .withCondition('ad_group_ad.policy_summary.review_status = REVIEW_IN_PROGRESS')
        .get();

      underReviewAdsCount = underReviewIterator.totalNumEntities();
    } catch (e) {
      Logger.log('Ошибка получения UNDER_REVIEW: ' + e);
    }

    if (disapprovedAdsCount === 0 && underReviewAdsCount === 0) {
      return '🟢 Модерация: нет disapproved/under review';
    }

    return '🛡️ Модерация: disapproved = ' + disapprovedAdsCount +
      ', under review = ' + underReviewAdsCount;
  } catch (e) {
    Logger.log('Ошибка формирования сообщения модерации: ' + e);
    return null;
  }
}

function checkBudgetAndNotify(accountId, currencyCode, alertLimit) {
  try {
    var budgetOrder = AdsApp.budgetOrders().get().next();
    var limit = budgetOrder.getSpendingLimit(); // Общий лимит аккаунта
    var spent = AdsApp.currentAccount().getStatsFor('ALL_TIME').getCost(); // Расход за все время
    var amountOfBudget = limit - spent;

    var conversionRate = getConversionRate(currencyCode);
    if (conversionRate === null) {
      Logger.log('Не удалось получить курс для ' + currencyCode);
      return null;
    }

    var amountInUSD = amountOfBudget / conversionRate; // Конвертация в доллары

    // Логируем только остаток
    Logger.log("Остаток аккаунта - " + amountOfBudget + " " + currencyCode);

    if (amountOfBudget < alertLimit) {
      return '💰💰💰💰💰💰💰\n' + 'Остаток: ' + amountOfBudget.toFixed(2) + ' ' + currencyCode +
             ' (с учетом возможных корректировок). Остаток в долларах: ' + amountInUSD.toFixed(2) + ' USD. Внесите оплату!';
    }
  } catch (e) {
    Logger.log('Ошибка проверки бюджета: ' + e);
  }
  return null;
}

function getConversionRate(currency) {
  if (currency === 'USD') {
    return 1;
  }

  try {
    var url = 'https://api.exchangerate-api.com/v4/latest/USD';
    var response = UrlFetchApp.fetch(url);
    var data = JSON.parse(response.getContentText());
    if (data.rates[currency]) {
      return data.rates[currency];
    }
    Logger.log('Курс для ' + currency + ' не найден в ответе API');
  } catch (e) {
    Logger.log('Ошибка получения курса: ' + e + '. Используем fallback курс = 1.');
    return 1;
  }
  return 1;
}

function sendMessageToHub(hubUrl, payload, jwt) {
  try {
    var url = hubUrl;
    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + jwt
      },
      payload: JSON.stringify(payload)
    };
    var response = UrlFetchApp.fetch(url, options);
    Logger.log(response.getContentText());
  } catch (e) {
    Logger.log('Ошибка отправки сообщения в hub: ' + e);
  }
}

function getAdPerformanceData() {
  try {
    var today = Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd");
    var query = 'SELECT Date, AdGroupId, Impressions, Clicks, Cost ' +
      'FROM AUTOMATIC_PLACEMENTS_PERFORMANCE_REPORT ' +
      'WHERE Date = "' + today + '"';
    var report = AdsApp.report(query);
    var rows = report.rows();

    var youtubeImpressions = 0;
    var youtubeClicks = 0;
    var youtubeCost = 0;

    while (rows.hasNext()) {
      var row = rows.next();
      // Логируем каждую строку отчета
      // Logger.log('Полученные данные: ' + JSON.stringify(row)); // Закомментировано для сокращения логов

      // Суммируем показы и клики
      youtubeImpressions += parseInt(row['Impressions']) || 0; // Обработка NaN
      youtubeClicks += parseInt(row['Clicks']) || 0; // Обработка NaN
      youtubeCost += parseFloat(row['Cost']) || 0; // Обработка NaN
    }

    // Логируем итоговые значения
    Logger.log('Итоговые значения: YouTube - ' + youtubeImpressions + ' показов, ' + youtubeClicks + ' кликов, ' + youtubeCost.toFixed(2) + ' затрат');

    // Рассчитываем CPC (стоимость за клик)
    var youtubeCPC = (youtubeClicks > 0) ? (youtubeCost / youtubeClicks).toFixed(2) : '0.00';

    Logger.log('CPC: ' + youtubeCPC);

    return {
      youtube: {
        impressions: youtubeImpressions,
        clicks: youtubeClicks,
        cost: youtubeCost.toFixed(2), // Возвращаем значение в нужном формате
        cpc: youtubeCPC // Добавляем CPC в результат
      }
    };
  } catch (e) {
    Logger.log('Ошибка получения отчета о производительности рекламы: ' + e);
    return {
      youtube: {
        impressions: 0,
        clicks: 0,
        cost: '0.00',
        cpc: '0.00'
      }
    };
  }
}

function getBalanceInfo(currencyCode) {
  try {
    var budgetOrders = AdsApp.budgetOrders().get();

    if (!budgetOrders.hasNext()) {
      return {
        available: false,
        message: 'Budget order not found'
      };
    }

    var budgetOrder = budgetOrders.next();
    var limit = budgetOrder.getSpendingLimit();
    var spent = AdsApp.currentAccount().getStatsFor('ALL_TIME').getCost();

    var rate = getConversionRate(currencyCode);
    if (rate === null) {
      rate = 1;
    }

    if (limit === null) {
      return {
        available: true,
        unlimited: true,
        spent: parseFloat(spent.toFixed(2)),
        spentUsd: parseFloat((spent / rate).toFixed(2)),
        currencyCode: currencyCode
      };
    }

    var remaining = limit - spent;

    return {
      available: true,
      unlimited: false,
      limit: parseFloat(limit.toFixed(2)),
      spent: parseFloat(spent.toFixed(2)),
      remaining: parseFloat(remaining.toFixed(2)),
      limitUsd: parseFloat((limit / rate).toFixed(2)),
      spentUsd: parseFloat((spent / rate).toFixed(2)),
      remainingUsd: parseFloat((remaining / rate).toFixed(2)),
      currencyCode: currencyCode
    };
  } catch (e) {
    Logger.log('Ошибка получения balance: ' + e);
    return {
      available: false,
      error: String(e)
    };
  }
}