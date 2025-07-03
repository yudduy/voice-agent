module.exports = jest.fn().mockImplementation(() => {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({ sid: 'SM_mocked_sid' }),
    },
  };
}); 