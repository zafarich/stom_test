const {Bot, InlineKeyboard, Keyboard} = require("grammy");
const XLSX = require("xlsx");
const mongoose = require("mongoose");
const fs = require("fs");
const https = require("https");
require("dotenv").config();

// MongoDB ulanish URL
const mongoUrl = "mongodb://localhost:27017/quiz";

// Mongoose sxemalarini yaratish
const questionSchema = new mongoose.Schema({
  question: String,
  correctAnswer: String,
  options: [String],
});

const ticketSchema = new mongoose.Schema({
  ticketNumber: Number,
  questions: [questionSchema],
});

const userSessionSchema = new mongoose.Schema({
  userId: Number,
  currentTest: [
    {
      question: String,
      correctAnswer: String,
      options: [String],
      userAnswer: String,
    },
  ],
  currentQuestionIndex: Number,
  currentCorrectIndex: Number,
  score: Number,
  isRandomTest: Boolean,
  ticketNumber: Number,
});

const Ticket = mongoose.model("Ticket", ticketSchema);

const UserSession = mongoose.model("UserSession", userSessionSchema);

// Bot tokenini o'zingizning botingiz tokeniga almashtiring
const bot = new Bot(process.env.BOT_TOKEN);

async function connectToMongo() {
  try {
    await mongoose.connect(mongoUrl);
    console.log("MongoDB ga muvaffaqiyatli ulandi");
  } catch (error) {
    console.error("MongoDB ga ulanishda xatolik:", error);
  }
}

async function saveQuestions(questions) {
  try {
    const tickets = [];
    for (let i = 0; i < questions.length; i += 10) {
      const ticket = new Ticket({
        ticketNumber: Math.floor(i / 10) + 1,
        questions: questions.slice(i, i + 10),
      });
      tickets.push(ticket);
    }

    await Ticket.insertMany(tickets);
    return tickets.length;
  } catch (error) {
    console.error("Saqlashda xatolik:", error);
    return 0;
  }
}

// Excel faylni qayta ishlash
function processExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

  const questions = data
    .filter((row) => row.length >= 5)
    .map((row) => {
      // Barcha qiymatlarni string ga o'tkazamiz va bo'sh joylarni olib tashlaymiz
      const question = row[0].toString().trim();
      const correctAnswer = row[1].toString().trim();
      const options = [
        correctAnswer,
        row[2].toString().trim(),
        row[3].toString().trim(),
        row[4].toString().trim(),
      ];

      // Variantlarni aralashtirish
      const shuffledOptions = [...options].sort(() => Math.random() - 0.5);

      return {
        question: question,
        correctAnswer: correctAnswer,
        options: shuffledOptions,
      };
    })
    .filter((q) => q.question && q.correctAnswer);

  return questions;
}

async function getRandomQuestions(count) {
  const tickets = await Ticket.aggregate([
    {$unwind: "$questions"},
    {$sample: {size: count}},
    {
      $project: {
        "questions.question": 1,
        "questions.correctAnswer": 1,
        "questions.options": 1,
      },
    },
  ]);
  return tickets.map((t) => t.questions);
}

async function startNewTest(userId, isRandom = true) {
  try {
    let questions;
    if (isRandom) {
      questions = await getRandomQuestions(50);
    } else {
      const ticket = await Ticket.findOne({ticketNumber: 1});
      questions = ticket.questions;
    }

    const session = new UserSession({
      userId,
      currentTest: questions.map((q) => ({
        ...q,
        userAnswer: null,
      })),
      currentQuestionIndex: 0,
      score: 0,
      isRandomTest: isRandom,
    });
    await session.save();
    return session;
  } catch (error) {
    console.error("Test boshlashda xatolik:", error);
    return null;
  }
}

async function sendQuestion(ctx, session) {
  const currentQuestion = session.currentTest[session.currentQuestionIndex];
  const keyboard = new InlineKeyboard();

  // Debug uchun log
  console.log("Current question:", {
    question: currentQuestion.question,
    correctAnswer: currentQuestion.correctAnswer,
    options: currentQuestion.options,
  });

  // Savolni va variantlarni tayyorlash
  let questionText = "";

  // Agar random test bo'lmasa (ya'ni bilet bo'lsa), bilet raqamini ko'rsatamiz
  if (!session.isRandomTest) {
    questionText += `${session.ticketNumber}-билет\n\n`;
  }

  questionText += `Савол ${session.currentQuestionIndex + 1}/${
    session.currentTest.length
  }:\n\n`;
  questionText += currentQuestion.question + "\n\n";
  questionText += "Вариантлар:\n";
  const variants_keys = ["А", "Б", "В", "Г"];
  currentQuestion.options.forEach((option, index) => {
    questionText += `${variants_keys[index]}) ${option}\n`;
  });

  // Tugmalarni tayyorlash (faqat A, B, C, D)
  ["А", "Б", "В", "Г"].forEach((letter, index) => {
    keyboard.text(letter, `opt_${index}`);
    if (index % 2 === 1) keyboard.row();
  });

  // Joriy savol uchun to'g'ri javob indeksini saqlash
  session.currentCorrectIndex = currentQuestion.options.indexOf(
    currentQuestion.correctAnswer
  );
  await session.save();

  await ctx.reply(questionText, {reply_markup: keyboard});
}

// Botga kelgan xabarlarni qayta ishlash
bot.command("start", async (ctx) => {
  const keyboard = new Keyboard()
    .text("🎲 Имтихон олиш")
    .text("📚 Билетлар")
    .row()
    .resized();

  await ctx.reply(
    "Ассалому алайкум! Тест топшириш учун қуйидаги менюдан фойдаланинг:",
    {reply_markup: keyboard}
  );
});

bot.on("message:document", async (ctx) => {
  try {
    if (
      ctx.message.document.mime_type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const file = await ctx.getFile();
      const filePath = "./temp.xlsx";

      // Faylni yuklab olish
      const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const fileStream = fs.createWriteStream(filePath);

      await new Promise((resolve, reject) => {
        https
          .get(fileUrl, (response) => {
            response.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close();
              resolve();
            });
          })
          .on("error", (err) => {
            fs.unlink(filePath, () => reject(err));
          });
      });

      const questions = processExcel(filePath);
      const ticketCount = await saveQuestions(questions);

      fs.unlinkSync(filePath);

      await ctx.reply(
        `Excel файл муваффақиятли қайта ишланди!\nЖами ${ticketCount} та билет яратилди.\nҲар бир билетда 10 тадан савол мавжуд.`
      );
    } else {
      await ctx.reply("Илтимос, Excel (.xlsx) форматидаги файл юборинг!");
    }
  } catch (error) {
    console.error("Хатолик юз берди:", error);
    await ctx.reply(
      "Файлни қайта ишлашда хатолик юз берди. Илтимос, қайтадан уриниб кўринг."
    );
  }
});

bot.hears("🎲 Имтихон олиш", async (ctx) => {
  await UserSession.deleteMany({userId: ctx.from.id});

  const session = await startNewTest(ctx.from.id);
  if (session) {
    await sendQuestion(ctx, session);
  } else {
    await ctx.reply(
      "Тест бошлашда хатолик юз берди. Илтимос, қайтадан уриниб кўринг."
    );
  }
});

bot.hears("📚 Билетлар", async (ctx) => {
  await UserSession.deleteMany({userId: ctx.from.id});

  const tickets = await Ticket.distinct("ticketNumber");
  const keyboard = new InlineKeyboard();

  tickets.forEach((ticketNum, index) => {
    keyboard.text(`${ticketNum}-билет`, `bilet_${ticketNum}`);
    if (index % 3 === 2) keyboard.row();
  });
  if (tickets.length % 3 !== 0) keyboard.row();

  await ctx.reply("Билетни танланг:", {reply_markup: keyboard});
});

bot.on("callback_query", async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery.data;

    if (callbackData.startsWith("bilet_")) {
      await UserSession.deleteMany({userId: ctx.from.id});

      const ticketNum = parseInt(callbackData.split("_")[1]);
      const ticket = await Ticket.findOne({ticketNumber: ticketNum});
      if (ticket) {
        const session = new UserSession({
          userId: ctx.from.id,
          currentTest: ticket.questions.map((q) => ({
            ...q.toObject(),
            userAnswer: null,
          })),
          currentQuestionIndex: 0,
          currentCorrectIndex: -1,
          score: 0,
          isRandomTest: false,
          ticketNumber: ticketNum,
        });
        await session.save();
        try {
          await ctx.answerCallbackQuery();
        } catch (error) {
          console.log("Callback query жавобида хатолик:", error);
        }
        await sendQuestion(ctx, session);
      }
    } else if (callbackData.startsWith("opt_")) {
      const session = await UserSession.findOne({userId: ctx.from.id});
      if (
        session &&
        session.currentQuestionIndex < session.currentTest.length
      ) {
        const currentQuestion =
          session.currentTest[session.currentQuestionIndex];
        const selectedOptionIndex = parseInt(callbackData.split("_")[1]);

        currentQuestion.userAnswer =
          currentQuestion.options[selectedOptionIndex];
        const isCorrect = selectedOptionIndex === session.currentCorrectIndex;

        if (isCorrect) {
          session.score += 1;
          await ctx.reply("✅ Тўғри жавоб!");
        } else {
          await ctx.reply(
            `❌ Нотўғри жавоб!\nТўғри жавоб: ${currentQuestion.correctAnswer}`
          );
        }

        try {
          await ctx.answerCallbackQuery();
        } catch (error) {
          console.log("Callback query жавобида хатолик:", error);
        }

        if (session.isRandomTest || isCorrect) {
          session.currentQuestionIndex += 1;

          if (session.currentQuestionIndex < session.currentTest.length) {
            await session.save();
            await sendQuestion(ctx, session);
          } else {
            const resultMessage = `Тест якунланди!\n\nНатижа: ${session.score}/${session.currentTest.length} та тўғри жавоб`;
            await ctx.reply(resultMessage);
            await session.deleteOne();
          }
        } else {
          await session.save();
        }
      }
    }
  } catch (error) {
    console.error("Callback query ишловида хатолик:", error);
    try {
      await ctx.answerCallbackQuery({
        text: "Хатолик юз берди. Қайтадан уриниб кўринг",
        show_alert: true,
      });
    } catch (err) {
      console.log("Хатолик ҳақида хабар беришда муаммо:", err);
    }
  }
});

// Botni ishga tushirish
connectToMongo().then(() => {
  bot.start();
  console.log("Bot ishga tushdi!");
});
