import {
    Table,
    Column,
    Model,
    DataType,
    PrimaryKey,
    Index,
} from "sequelize-typescript";

@Table({
    tableName: "channels",
    timestamps: true,
})
export class Channel extends Model {
    @PrimaryKey
    @Column(DataType.STRING)
    id!: string;

    @Column(DataType.STRING)
    name!: string;

    @Column(DataType.TEXT)
    cmd!: string;

    @Column(DataType.STRING)
    logo!: string;

    @Index
    @Column(DataType.STRING)
    tv_genre_id!: string;

    @Column(DataType.STRING)
    censored!: string;

    @Column(DataType.INTEGER)
    number?: number;

    @Index
    @Column(DataType.INTEGER)
    profileId?: number;
}
