import dispatcher_data


def test_import() -> None:
    assert callable(dispatcher_data.main)
